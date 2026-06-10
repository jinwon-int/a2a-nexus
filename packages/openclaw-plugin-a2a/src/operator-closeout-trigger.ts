/**
 * Operator closeout-trigger metadata contract (#399, #404).
 *
 * Defines the metadata contract for automatic parent-round closeout triggers.
 * Every operator notification that participates in parent-round closeout MUST
 * carry a closeout-trigger metadata block conforming to this contract.
 *
 * Extended in #404 for auto-closeout dry-run candidate/status with states:
 * waiting, blocked, draft_ready, comment_only_ready, comment_and_close_requires_approval.
 *
 * Source-only contract: closeout is never auto-enabled.
 * No live provider send, no terminal ACK.
 *
 * Issue:  jinwon-int/plugin-a2a#404
 * Parent: jinwon-int/a2a-broker#841
 */
import type { A2AOperatorTerminalNotificationEnvelope } from "./operator-terminal-notifier.js";

// ── Schema ─────────────────────────────────────────────────────────

/** Schema identifier for closeout-trigger metadata. */
export const A2A_OPERATOR_CLOSEOUT_TRIGGER_SCHEMA =
  "a2a.operator.closeout-trigger.v1" as const;

// ── Closeout candidate states ──────────────────────────────────────

/**
 * Closeout evaluation state for a parent round.
 *
 * States (from #404 auto-closeout dry-run):
 * - `waiting`: lanes still outstanding; closeout cannot yet be evaluated.
 * - `blocked`: one or more lanes are in a blocked/failed state that prevents
 *   closeout; manual intervention or escalation required.
 * - `draft_ready`: all expected lane notifications received and successful;
 *   the N/N closeout draft is ready to be presented to the operator.
 *   This is the initial ready state after all lanes complete.
 * - `comment_only_ready`: the N/N closeout content is ready to be posted
 *   as a comment, but the issue should NOT be closed. Used when closeout
 *   is informational/sharing-only or the finalizer handles close separately.
 * - `comment_and_close_requires_approval`: the N/N closeout is ready and
 *   the issue should be closed, but explicit operator approval is required
 *   before proceeding with the close action.
 */
export type A2ACloseoutCandidateState =
  | "waiting"
  | "blocked"
  | "draft_ready"
  | "comment_only_ready"
  | "comment_and_close_requires_approval";

// ── Closeout-trigger metadata (per-notification) ───────────────────

/**
 * Operator closeout-trigger metadata contract.
 *
 * This block MUST be present on every operator notification that participates
 * in parent-round closeout evaluation. It provides the unambiguous metadata
 * that broker automation needs to determine when all lanes have completed
 * and a final N/N closeout trigger can be emitted.
 */
export type A2AOperatorCloseoutTriggerMetadata = {
  /** Schema identifier — must be "a2a.operator.closeout-trigger.v1". */
  schema: typeof A2A_OPERATOR_CLOSEOUT_TRIGGER_SCHEMA;
  /** Contract version (currently 1). */
  version: 1;

  // ── Parent round identification ──────────────────────────────────

  /** Parent round identifier. */
  parentRoundId: string;

  /**
   * Total number of worker/lane tasks expected in the parent round
   * (denominator for closeout evaluation).
   */
  parentRoundTotal: number;

  /**
   * Total terminal notifications observed so far for this parent round.
   * MUST NOT exceed parentRoundTotal. When terminalCount >= parentRoundTotal,
   * the closeout evaluator may consider the round candidate-ready.
   */
  terminalCount: number;

  /**
   * Number of successful completions observed so far for this parent round.
   * Used alongside terminalCount to determine whether the round can close
   * (all terminals known) or is blocked (failures present).
   */
  successCount: number;

  // ── Lane identification ──────────────────────────────────────────

  /**
   * 1-based lane order within the parent round.
   *
   * ⚠️  Lane order (parentRoundOrder) is NOT a progress/success count.
   * Lane 4/4 with parentRoundOrder=4 does NOT imply 4 completions;
   * the actual completed count is tracked in parentRoundProgress or
   * roundProgress.completed. Title builders MUST use the completed count,
   * NOT lane order, as the numerator in "완료 N/M" indicators.
   *
   * See A2A_CLOSEOUT_TITLE_RULE for the formal title contract.
   */
  laneOrder: number;

  // ── Broker identification ────────────────────────────────────────

  /** Broker that initiated the parent round. */
  originBrokerId: string;

  /**
   * Broker of record for rendering/closeout.
   * The broker identified here is responsible for consuming this
   * closeout-trigger metadata and evaluating the closeout candidate state.
   */
  brokerOfRecordId: string;

  // ── Notification identification (for idempotency) ────────────────

  /**
   * Stable operator notification identifier.
   * Derived from the original terminal event — the same terminal event
   * always produces the same operatorNotificationId.
   */
  operatorNotificationId: string;

  /**
   * Stable idempotency key for this operator notification.
   *
   * Duplicate terminal events produce identical dedupeKey values.
   * Out-of-order delivery does not alter dedupeKey stability.
   * Closeout evaluation MUST deduplicate by dedupeKey to avoid
   * double-counting a single lane completion.
   */
  dedupeKey: string;

  // ── Outbox timing ─────────────────────────────────────────────────

  /**
   * Outbox event timestamp (ISO-8601) when available from the terminal
   * outbox record. Exposed in the final N/N title/body for operator
   * traceability.
   *
   * When multiple outbox events are aggregated, this is the latest
   * observed outbox timestamp.
   */
  outboxTime?: string;

  // ── Receipt semantics ────────────────────────────────────────────

  /**
   * Provider delivery receipt is never operator-visible ACK evidence.
   *
   * Inherits the existing receipt projection rule:
   *   providerGatewaySendSuccess = "not_ack_evidence"
   *
   * Cross-broker projections are bounded terminal evidence only;
   * provider send success is never operator-visible ACK evidence.
   * Closeout automation MUST NOT treat provider delivery receipt
   * as operator confirmation.
   */
  receiptRule: "not_ack_evidence";
};

// ── Title contract ─────────────────────────────────────────────────

/**
 * Title contract: lane order MUST NOT be confused with success count.
 *
 * Every closeout-participating notification title MUST use the
 * completed-count numerator (roundNum / parentRoundProgress), NOT the lane
 * order (parentRoundOrder), for the "완료 N/M" indicator.
 *
 * The final N/N title/body MUST expose:
 * - terminal count (observed total after dedup)
 * - success count
 * - lane order
 * - parentRoundId
 * - parentRoundTotal
 * - broker ids (originBrokerId, brokerOfRecordId)
 * - outbox time when available
 *
 * ## Examples
 *
 * | Scenario                     | laneOrder | roundNum | title                                    | Correct? |
 * |------------------------------|-----------|----------|------------------------------------------|----------|
 * | Lane 1, first completion     | 1         | 1        | "… worker(완료 1/4)"                     | ✅       |
 * | Lane 4, only lane completed  | 4         | 1        | "… worker(완료 1/4)"                     | ✅       |
 * | Lane 4, using laneOrder=4    | 4         | 1        | "… worker(완료 4/4)"                     | ❌       |
 * | Single lane, only completion | 1         | 1        | "… worker(완료 1/1)"                     | ✅       |
 *
 * The builder in operator-terminal-notifier.ts already enforces this rule
 * by preferring roundProgress.completed / parentRoundProgress over
 * parentRoundOrder for the title numerator.
 */
export const A2A_CLOSEOUT_TITLE_RULE: {
  readonly numeratorSource: "completed_progress" | "lane_order";
  readonly laneOrderInTitleIsBreach: true;
  readonly titleBodyFields: readonly string[];
} = {
  numeratorSource: "completed_progress",
  laneOrderInTitleIsBreach: true,
  titleBodyFields: [
    "terminalCount",
    "successCount",
    "laneOrder",
    "parentRoundId",
    "parentRoundTotal",
    "originBrokerId",
    "brokerOfRecordId",
    "outboxTime",
  ],
} as const;

// ── Candidate evaluation ───────────────────────────────────────────

/**
 * Input to closeout candidate evaluation.
 *
 * Encapsulates the per-parent-round aggregation that the broker
 * automation accumulates from operator notifications.
 */
export type A2ACloseoutCandidateInput = {
  /** Parent round identifier. */
  parentRoundId: string;
  /** Total expected worker/lane tasks (denominator). */
  parentRoundTotal: number;
  /** Origin broker. */
  originBrokerId: string;
  /** Broker of record. */
  brokerOfRecordId: string;
  /**
   * Observed terminal notifications, deduplicated by dedupeKey.
   * Must not contain duplicate dedupeKey values.
   */
  observations: A2ACloseoutObservation[];

  // ── Progressive state context (#404) ─────────────────────────────

  /**
   * Whether the N/N closeout draft has been prepared.
   * When true, the evaluation may transition to comment_only_ready
   * instead of draft_ready.
   */
  draftPrepared?: boolean;

  /**
   * Whether an N/N comment has already been posted.
   * When true, the evaluation may transition to
   * comment_and_close_requires_approval (if close needs approval) or
   * comment_only_ready (if close-handled separately).
   */
  commentPosted?: boolean;

  /**
   * Whether operator approval is required before closing the issue.
   * When true and commentPosted is already true, the state is
   * comment_and_close_requires_approval.
   */
  requiresApprovalBeforeClose?: boolean;
};

/**
 * Single observation from an operator notification.
 */
export type A2ACloseoutObservation = {
  /** Notification type. */
  type: "success" | "failure" | "block" | "pr";
  /** Lane order within the parent round. */
  laneOrder: number;
  /** Stable idempotency key. */
  dedupeKey: string;
  /** Stable operator notification identifier. */
  operatorNotificationId: string;
};

/**
 * Closeout evaluation result for a parent round.
 */
export type A2ACloseoutCandidateEvaluation = {
  /** Evaluated state. */
  state: A2ACloseoutCandidateState;
  /** Parent round identifier. */
  parentRoundId: string;
  /** Total expected lanes. */
  parentRoundTotal: number;
  /** Count of unique terminal observations (after deduplication). */
  observedCount: number;
  /** Count of successful observations. */
  successCount: number;
  /** Count of blocked/failure observations. */
  blockedCount: number;
  /** Count of lanes still waiting (parentRoundTotal - observedCount). */
  waitingCount: number;
  /** Human-readable summary of the evaluation. */
  summary: string;
};

/**
 * Evaluate the closeout candidate state for a parent round.
 *
 * Pure projection — no side effects, no live sends, no terminal ACK.
 *
 * Closeout evaluation rules (extended #404):
 * 1. Deduplicate observations by dedupeKey before counting.
 * 2. If any observation is "block" or "failure" → state is "blocked".
 * 3. If observedCount < parentRoundTotal → state is "waiting".
 * 4. If all lanes observed, all successful:
 *    a. If comment already posted and close needs approval → "comment_and_close_requires_approval".
 *    b. If comment already posted (no close approval needed) → "comment_only_ready".
 *    c. If draft already prepared (but no comment yet) → "comment_only_ready" (ready to share).
 *    d. Otherwise → "draft_ready" (first time all notifications received).
 *
 * @param input — Deduplicated aggregate of all operator notifications
 *   for a single parent round, plus progressive state context.
 * @returns Closeout evaluation result.
 */
export function evaluateA2AOperatorCloseoutCandidate(
  input: A2ACloseoutCandidateInput,
): A2ACloseoutCandidateEvaluation {
  // Deduplicate observations by dedupeKey (stable idempotency).
  const seen = new Set<string>();
  const unique: A2ACloseoutObservation[] = [];
  for (const obs of input.observations) {
    if (!seen.has(obs.dedupeKey)) {
      seen.add(obs.dedupeKey);
      unique.push(obs);
    }
  }

  const observedCount = unique.length;
  const successCount = unique.filter((o) => o.type === "success" || o.type === "pr").length;
  const blockedCount = unique.filter((o) => o.type === "block" || o.type === "failure").length;
  const waitingCount = Math.max(0, input.parentRoundTotal - observedCount);

  // Rule 2: blocked/failure present → blocked
  if (blockedCount > 0) {
    return {
      state: "blocked",
      parentRoundId: input.parentRoundId,
      parentRoundTotal: input.parentRoundTotal,
      observedCount,
      successCount,
      blockedCount,
      waitingCount,
      summary: `CLOSEOUT BLOCKED: ${blockedCount} lane(s) blocked/failed (${successCount} success, ${waitingCount} waiting) — manual intervention required`,
    };
  }

  // Rule 3: still waiting for lanes
  if (observedCount < input.parentRoundTotal) {
    return {
      state: "waiting",
      parentRoundId: input.parentRoundId,
      parentRoundTotal: input.parentRoundTotal,
      observedCount,
      successCount,
      blockedCount,
      waitingCount,
      summary: `CLOSEOUT WAITING: ${observedCount}/${input.parentRoundTotal} lanes observed, ${waitingCount} lane(s) still outstanding`,
    };
  }

  // Rule 4: all lanes observed, all successful — determine progressive state.
  if (input.commentPosted && input.requiresApprovalBeforeClose) {
    return {
      state: "comment_and_close_requires_approval",
      parentRoundId: input.parentRoundId,
      parentRoundTotal: input.parentRoundTotal,
      observedCount,
      successCount,
      blockedCount,
      waitingCount,
      summary: `CLOSEOUT APPROVAL REQUIRED: ${observedCount}/${input.parentRoundTotal} lanes complete — comment posted, close requires operator approval`,
    };
  }

  if (input.commentPosted) {
    return {
      state: "comment_only_ready",
      parentRoundId: input.parentRoundId,
      parentRoundTotal: input.parentRoundTotal,
      observedCount,
      successCount,
      blockedCount,
      waitingCount,
      summary: `CLOSEOUT COMMENT READY: ${observedCount}/${input.parentRoundTotal} lanes complete — comment posted, awaiting final close`,
    };
  }

  if (input.draftPrepared) {
    return {
      state: "comment_only_ready",
      parentRoundId: input.parentRoundId,
      parentRoundTotal: input.parentRoundTotal,
      observedCount,
      successCount,
      blockedCount,
      waitingCount,
      summary: `CLOSEOUT COMMENT READY: ${observedCount}/${input.parentRoundTotal} lanes complete — draft prepared, ready to post comment`,
    };
  }

  return {
    state: "draft_ready",
    parentRoundId: input.parentRoundId,
    parentRoundTotal: input.parentRoundTotal,
    observedCount,
    successCount,
    blockedCount,
    waitingCount,
    summary: `CLOSEOUT DRAFT READY: ${observedCount}/${input.parentRoundTotal} lanes complete (all successful) — N/N summary draft available`,
  };
}

/**
 * Closeout-trigger metadata extraction options.
 *
 * Provides broker identification context that may not yet be carried
 * directly on the notification envelope. These can be supplied by the
 * calling code (typically the operator-event-bridge or notifier adapter)
 * that has access to parent-round metadata.
 */
export type A2AOperatorCloseoutTriggerContext = {
  /** Broker that initiated the parent round (overrides envelope value). */
  originBrokerId?: string;
  /** Broker of record for rendering/closeout (overrides envelope value). */
  brokerOfRecordId?: string;
  /** Terminal count override — when ctx knows how many terminals exist. */
  terminalCount?: number;
  /**
   * Outbox event timestamp (ISO-8601). When provided, it is included in
   * the extracted metadata for N/N title/body exposure.
   */
  outboxTime?: string;
};

/**
 * Extract closeout-trigger metadata from an operator notification envelope.
 *
 * Returns undefined if the envelope does not carry parent-round context
 * (no parentRoundId, no parentRoundTotal, no parentRoundOrder).
 *
 * Pure projection — no side effects, no live sends, no terminal ACK.
 *
 * Extended in #404 to propagate outboxTime when context provides it,
 * enabling the final N/N title/body to expose outbox timing for
 * operator traceability.
 */
export function extractA2AOperatorCloseoutTriggerMetadata(
  envelope: A2AOperatorTerminalNotificationEnvelope,
  context?: A2AOperatorCloseoutTriggerContext,
): A2AOperatorCloseoutTriggerMetadata | undefined {
  // Must have parent-round context.
  if (!envelope.parentRoundId || envelope.parentRoundTotal === undefined) {
    return undefined;
  }

  // Read lane order—this is parentRoundOrder (NOT parentRoundProgress).
  const laneOrder = envelope.parentRoundOrder ?? 0;
  if (laneOrder < 1) {
    return undefined;
  }

  // Broker IDs: prefer context override, then fallback.
  // The envelope currently does not carry origin/broker-of-record;
  // context must be provided by the caller (e.g. operator-event-bridge).
  const originBrokerId = context?.originBrokerId ?? "unknown";
  const brokerOfRecordId = context?.brokerOfRecordId ?? originBrokerId;

  return {
    schema: A2A_OPERATOR_CLOSEOUT_TRIGGER_SCHEMA,
    version: 1,
    parentRoundId: envelope.parentRoundId,
    parentRoundTotal: envelope.parentRoundTotal,
    terminalCount: context?.terminalCount ?? 1, // Default: this notification represents one terminal event.
    successCount: envelope.type === "success" || envelope.type === "pr" ? 1 : 0,
    laneOrder,
    originBrokerId,
    brokerOfRecordId,
    operatorNotificationId: envelope.id,
    dedupeKey: envelope.dedupeKey,
    ...(context?.outboxTime ? { outboxTime: context.outboxTime } : {}),
    receiptRule: "not_ack_evidence",
  };
}
