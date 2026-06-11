/**
 * Cleanup dry-run projection — operator-facing status for broker DB
 * lifecycle cleanup / safe-prune lane.
 *
 * Issue:  jinwon-int/plugin-a2a#278
 * Parent: jinwon-int/a2a-broker#519
 *
 * This module provides read-only projection of cleanup candidates,
 * a dry-run plan with approval gates, and receipt-runtime boundaries
 * that enforce:
 *   - Accepted-send is NEVER terminal ACK.
 *   - Cleanup execution CANNOT be implied by notification.
 *   - All mutation paths require an explicit operator confirmation gate.
 *   - Fail-closed for stale worker rows that may still be valid
 *     home-broker records.
 *
 * Safety gates:
 *   - No production DB mutation/prune/migration
 *   - No deploy/restart
 *   - No live provider send
 *   - No terminal ACK
 *   - No secret/edge-secret changes
 *   - All results are pure projection artifacts — no real side effects
 */

// ── Public types ────────────────────────────────────────────────────

/** Risk class assigned to a cleanup candidate. */
export type CleanupRiskClass =
  | "safe"
  | "low"
  | "medium"
  | "high"
  | "blocked";

/** A single projected cleanup candidate (read-only discovery). */
export type CleanupCandidateProjection = {
  /** Stable candidate id for audit trail (never a real row PK). */
  candidateId: string;
  /** Human-readable label for operator review. */
  label: string;
  /** Reason this candidate was flagged. */
  reason: string;
  /** Risk class. */
  riskClass: CleanupRiskClass;
  /** Source broker or worker context. */
  source: string;
  /** Approximate row age in seconds (if known). */
  ageSeconds?: number;
  /** Whether this candidate requires explicit operator acknowledgment. */
  requiresOperatorApproval: boolean;
  /** Backup/checkpoint notes. */
  backupNotes?: string;
};

/** Projection of all discovered cleanup candidates. */
export type CleanupCandidateDiscoveryProjection = {
  schema: "a2a.cleanup.candidate-discovery.v1";
  /** Run identifier. */
  runId: string;
  /** When the discovery was produced (epoch ms). */
  producedAt: number;
  /** Total candidates discovered. */
  totalCandidates: number;
  /** Breakdown by risk class. */
  countsByRisk: Record<CleanupRiskClass, number>;
  /** The candidates themselves (max capped for projection safety). */
  candidates: CleanupCandidateProjection[];
  /** Whether this projection is a dry-run only. */
  dryRun: true;
};

/** Status of the operator cleanup receipt gate. */
export type CleanupReceiptStatus =
  /** Provider accepted the send — NOT terminal ACK, NOT operator receipt. */
  | "provider_accepted_send"
  /** Notification delivered to the operator channel. */
  | "notification_delivered"
  /** Operator has visibly acknowledged the cleanup plan. */
  | "operator_acknowledged"
  /** Operator explicitly approved the mutation path. */
  | "operator_approved";

/** Whether the cleanup receipt gate is satisfied. */
export type CleanupReceiptGateVerdict =
  | { satisfied: true; receiptStatus: CleanupReceiptStatus }
  | {
      satisfied: false;
      receiptStatus: CleanupReceiptStatus;
      reason: string;
    };

/** Step in a cleanup dry-run plan. */
export type CleanupPlanStep = {
  /** Stable step id for audit trail. */
  stepId: string;
  /** Human-readable description. */
  description: string;
  /** Candidate ids this step targets. */
  candidateIds: string[];
  /** Risk class of the step. */
  riskClass: CleanupRiskClass;
  /** Whether this step requires operator approval before execution. */
  operatorGated: boolean;
  /** Whether this step is currently blocked. */
  blocked: boolean;
  /** Why this step is blocked (if blocked). */
  blockReason?: string;
  /** Rollback/abort notes for this step. */
  rollbackNotes: string;
};

/** The projected cleanup dry-run plan. */
export type CleanupDryRunPlanProjection = {
  schema: "a2a.cleanup.dry-run-plan.v1";
  /** Run identifier. */
  runId: string;
  /** When the plan was produced (epoch ms). */
  producedAt: number;
  /** Summary line for the operator. */
  summary: string;
  /** Total steps in the plan. */
  totalSteps: number;
  /** Steps that require operator approval. */
  operatorGatedSteps: number;
  /** Steps that are blocked. */
  blockedSteps: number;
  /** The plan steps. */
  steps: CleanupPlanStep[];
  /** Explicit backup/checkpoint requirement before any execution. */
  backupRequired: boolean;
  /** Backup/checkpoint notes for the operator. */
  backupCheckpointNotes: string;
  /** Whether an operator approval token is required for the mutation path. */
  approvalTokenRequired: true;
  /** Rollback/abort runbook URL or instruction. */
  rollbackRunbook: string;
  /** Whether this plan is dry-run only. */
  dryRun: true;
};

/** Operator-facing status projection for the cleanup gate. */
export type CleanupGateStatusProjection = {
  schema: "a2a.cleanup.gate-status.v1";
  /** Run identifier. */
  runId: string;
  /** When the status was produced (epoch ms). */
  producedAt: number;
  /** Are we in a safe state for cleanup consideration? */
  safeForCleanup: boolean;
  /** Current receipt gate status. */
  receiptStatus: CleanupReceiptStatus;
  /** Receipt gate verdict. */
  receiptGate: CleanupReceiptGateVerdict;
  /** Whether the operator has acknowledged the cleanup plan. */
  operatorAcknowledged: boolean;
  /** Whether the operator has approved the mutation path. */
  operatorApproved: boolean;
  /** Whether the approval token is valid. */
  approvalTokenValid: boolean;
  /** Whether the backup/checkpoint has been confirmed. */
  backupConfirmed: boolean;
  /** Human-readable status summary. */
  summary: string;
  /** Warnings the operator should see. */
  warnings: string[];
  /** Whether accepted-send could be mistaken for terminal ACK in this state. */
  acceptedSendIsNotTerminalAck: true;
  /** Whether notification alone could imply cleanup completion. */
  notificationImpliesCleanup: false;
  /** Whether this status is a dry-run projection. */
  dryRun: true;
};

/** Audit entry for a cleanup operation (projected, never real). */
export type CleanupAuditEntry = {
  /** When the audit entry was created (epoch ms). */
  timestamp: number;
  /** What occurred. */
  action: string;
  /** Candidate ids involved. */
  candidateIds: string[];
  /** Result of the action. */
  result: "projected" | "blocked" | "requires_approval";
  /** Operator notes. */
  notes: string;
  /** Whether this is a real or projected entry. */
  projected: true;
};

/** Input for the cleanup dry-run projection. */
export type CleanupDryRunProjectionInput = {
  /** Discovery projection from candidate discovery. */
  discovery: CleanupCandidateDiscoveryProjection;
  /** Optional override for candidate filtering. */
  maxRisk?: CleanupRiskClass;
  /** Optional list of candidate ids to exclude. */
  excludeCandidateIds?: string[];
  /** Arbitrary metadata for operator context. */
  metadata?: Record<string, unknown>;
};

/** Options for the cleanup dry-run projection. */
export type CleanupDryRunProjectionOptions = {
  runId?: string;
  now?: () => number;
};

// ── Constants ───────────────────────────────────────────────────────

/** Receipt statuses that are NOT terminal ACK — always fail-closed. */
const NON_TERMINAL_RECEIPT_STATUSES: ReadonlySet<CleanupReceiptStatus> =
  new Set(["provider_accepted_send", "notification_delivered"]);

/** Receipt statuses that allow mutation path consideration. */
const TERMINAL_RECEIPT_STATUSES: ReadonlySet<CleanupReceiptStatus> =
  new Set(["operator_acknowledged", "operator_approved"]);

/** Default backup checkpoint notes. */
const DEFAULT_BACKUP_CHECKPOINT_NOTES =
  "A full backup or DB checkpoint MUST be confirmed by the operator before " +
  "ANY cleanup mutation step executes. Without backup confirmation, all " +
  "cleanup steps MUST remain gated. The operator is responsible for verifying " +
  "backup integrity before clearing the gate.";

/** Default rollback runbook. */
const DEFAULT_ROLLBACK_RUNBOOK =
  "If cleanup produces unexpected side effects:\n" +
  "1. Pause all broker workers.\n" +
  "2. Restore from the pre-cleanup backup/checkpoint.\n" +
  "3. Validate broker health and worker connectivity.\n" +
  "4. Re-run candidate discovery to confirm state.\n" +
  "5. Resume workers only after operator confirmation.";

// ── Public API ──────────────────────────────────────────────────────

/**
 * Project a cleanup dry-run plan from candidate discovery.
 *
 * This produces an operator-facing plan that enumerates every cleanup step
 * with its risk class, operator-gating requirement, and rollback notes.
 * Every step that could mutate MUST be operator-gated.
 *
 * This is a pure projection — it never executes, prunes, migrates,
 * sends, deploys, or mutates anything.
 */
export function projectCleanupDryRunPlan(
  input: CleanupDryRunProjectionInput,
  options: CleanupDryRunProjectionOptions = {},
): CleanupDryRunPlanProjection {
  const now = options.now ?? Date.now;
  const runId = options.runId ?? `cleanup-dry-run-${now()}`;
  const producedAt = now();

  const { discovery, maxRisk, excludeCandidateIds } = input;
  const excluded = new Set(excludeCandidateIds ?? []);

  // Filter candidates by risk and exclusion
  const eligible = discovery.candidates.filter((c) => {
    if (excluded.has(c.candidateId)) return false;
    if (maxRisk && riskOrdinal(c.riskClass) > riskOrdinal(maxRisk)) return false;
    return true;
  });

  // Group candidates by risk class for step creation
  const steps: CleanupPlanStep[] = [];
  const riskOrder: CleanupRiskClass[] = ["safe", "low", "medium", "high", "blocked"];

  for (const riskClass of riskOrder) {
    const group = eligible.filter((c) => c.riskClass === riskClass);
    if (group.length === 0) continue;

    const operatorGated = riskClass !== "safe";
    const blocked = riskClass === "blocked";
    const candidateIds = group.map((c) => c.candidateId);

    steps.push({
      stepId: `cleanup-step-${riskClass}-${steps.length}`,
      description: `Cleanup ${group.length} ${riskClass}-risk candidate(s): ${group.map((c) => c.label).join(", ")}`,
      candidateIds,
      riskClass,
      operatorGated,
      blocked,
      blockReason: blocked
        ? "Candidates are blocked — may still be valid home-broker records. Manual operator review required before any action."
        : undefined,
      rollbackNotes:
        riskClass === "high" || riskClass === "blocked"
          ? "Restore from backup required. Do NOT proceed without confirmed checkpoint."
          : "Restore from backup if any side effects observed.",
    });
  }

  const operatorGatedSteps = steps.filter((s) => s.operatorGated).length;
  const blockedSteps = steps.filter((s) => s.blocked).length;

  const summary =
    eligible.length === 0
      ? "No cleanup candidates eligible for the current risk threshold."
      : `${eligible.length} candidate(s) across ${steps.length} step(s). ` +
        `${operatorGatedSteps} step(s) require operator approval. ` +
        `${blockedSteps} step(s) are blocked. Dry-run only — no mutation has occurred.`;

  return {
    schema: "a2a.cleanup.dry-run-plan.v1",
    runId,
    producedAt,
    summary,
    totalSteps: steps.length,
    operatorGatedSteps,
    blockedSteps,
    steps,
    backupRequired: true,
    backupCheckpointNotes: DEFAULT_BACKUP_CHECKPOINT_NOTES,
    approvalTokenRequired: true,
    rollbackRunbook: DEFAULT_ROLLBACK_RUNBOOK,
    dryRun: true,
  };
}

/**
 * Resolve the cleanup receipt gate verdict.
 *
 * This is the core safety mechanism: it ensures that accepted-send
 * (`provider_accepted_send`) is NEVER treated as terminal ACK and that
 * cleanup execution CANNOT be implied by a notification delivery.
 *
 * Only when the operator has explicitly acknowledged or approved the plan
 * can the receipt gate be considered satisfied.
 *
 * @param receiptStatus The current receipt status
 * @returns Whether the receipt gate is satisfied and why
 */
export function resolveCleanupReceiptGate(
  receiptStatus: CleanupReceiptStatus,
): CleanupReceiptGateVerdict {
  switch (receiptStatus) {
    case "provider_accepted_send":
      return {
        satisfied: false,
        receiptStatus,
        reason:
          "Provider accepted-send is NOT terminal ACK. " +
          "The cleanup operation has not been acknowledged by the operator. " +
          "Do NOT proceed with any mutation path.",
      };
    case "notification_delivered":
      return {
        satisfied: false,
        receiptStatus,
        reason:
          "Notification delivered does NOT imply cleanup completion. " +
          "The operator must still explicitly acknowledge the cleanup plan " +
          "before any mutation path is considered.",
      };
    case "operator_acknowledged":
      return {
        satisfied: true,
        receiptStatus,
      };
    case "operator_approved":
      return {
        satisfied: true,
        receiptStatus,
      };
  }
}

/**
 * Check whether a given receipt status is terminal for cleanup purposes.
 *
 * NON_TERMINAL: `provider_accepted_send`, `notification_delivered`
 * TERMINAL:     `operator_acknowledged`, `operator_approved`
 *
 * This is the defense against "accepted-send as terminal ACK".
 */
export function isCleanupReceiptTerminal(
  receiptStatus: CleanupReceiptStatus,
): boolean {
  return TERMINAL_RECEIPT_STATUSES.has(receiptStatus);
}

/**
 * Project the operator-facing cleanup gate status.
 *
 * This synthesizes the discovery projection, dry-run plan, and receipt
 * status into a single operator-facing status card. It explicitly
 * asserts that accepted-send is NOT terminal ACK and that notification
 * does NOT imply cleanup completion.
 */
export function projectCleanupGateStatus(
  discovery: CleanupCandidateDiscoveryProjection,
  plan: CleanupDryRunPlanProjection,
  receiptStatus: CleanupReceiptStatus,
  options: {
    runId?: string;
    now?: () => number;
    operatorAcknowledged?: boolean;
    operatorApproved?: boolean;
    approvalTokenValid?: boolean;
    backupConfirmed?: boolean;
  } = {},
): CleanupGateStatusProjection {
  const now = options.now ?? Date.now;
  const runId = options.runId ?? `cleanup-gate-status-${now()}`;
  const producedAt = now();

  const receiptGate = resolveCleanupReceiptGate(receiptStatus);
  const operatorAcknowledged =
    options.operatorAcknowledged ?? (receiptStatus === "operator_acknowledged" || receiptStatus === "operator_approved");
  const operatorApproved =
    options.operatorApproved ?? (receiptStatus === "operator_approved");

  // The plan declares approvalTokenRequired: true, so the conjunction must
  // include operator approval and a valid token — without them an
  // acknowledged-but-unapproved state could report safe-to-mutate.
  const safeForCleanup =
    discovery.totalCandidates > 0 &&
    plan.totalSteps > 0 &&
    receiptGate.satisfied &&
    operatorAcknowledged &&
    operatorApproved &&
    (options.approvalTokenValid ?? false) &&
    (options.backupConfirmed ?? false);

  const warnings: string[] = [];

  if (!options.backupConfirmed) {
    warnings.push(
      "Backup/checkpoint NOT confirmed. All mutation steps remain gated until backup is verified.",
    );
  }

  if (plan.blockedSteps > 0) {
    warnings.push(
      `${plan.blockedSteps} step(s) are blocked. These may reference valid home-broker records. Manual operator review required.`,
    );
  }

  if (receiptStatus === "provider_accepted_send") {
    warnings.push(
      "Current receipt status is 'provider_accepted_send'. " +
        "This is NOT terminal ACK — do NOT proceed with any cleanup mutation.",
    );
  }

  if (receiptStatus === "notification_delivered") {
    warnings.push(
      "Notification was delivered but operator has not yet acknowledged. " +
        "Cleanup execution cannot be implied by notification delivery.",
    );
  }

  if (discovery.totalCandidates === 0) {
    warnings.push("No cleanup candidates discovered. Gate status is informational only.");
  }

  for (const candidate of discovery.candidates) {
    if (candidate.riskClass === "blocked" || candidate.riskClass === "high") {
      warnings.push(
        `High-risk candidate ${candidate.candidateId} (${candidate.label}): ` +
          `${candidate.reason}. Fail-closed — treat as valid until operator confirms otherwise.`,
      );
    }
  }

  // Deduplicate warnings
  const uniqueWarnings = [...new Set(warnings)];

  const summary = safeForCleanup
    ? `Cleanup gate status: ready for operator-approved execution. ` +
      `${discovery.totalCandidates} candidate(s), ${plan.operatorGatedSteps} operator-gated step(s). ` +
      `Backup confirmed. Dry-run projection only — no mutation has occurred.`
    : `Cleanup gate status: NOT ready. ` +
      `${receiptGate.satisfied ? "Receipt OK." : `Receipt blocked: ${receiptGate.reason}`} ` +
      `${operatorAcknowledged ? "Acknowledged." : "Operator acknowledgment pending."} ` +
      `${options.backupConfirmed ? "Backup confirmed." : "Backup NOT confirmed."} ` +
      `Dry-run projection only — no mutation has occurred.`;

  return {
    schema: "a2a.cleanup.gate-status.v1",
    runId,
    producedAt,
    safeForCleanup,
    receiptStatus,
    receiptGate,
    operatorAcknowledged,
    operatorApproved,
    approvalTokenValid: options.approvalTokenValid ?? false,
    backupConfirmed: options.backupConfirmed ?? false,
    summary,
    warnings: uniqueWarnings,
    acceptedSendIsNotTerminalAck: true,
    notificationImpliesCleanup: false,
    dryRun: true,
  };
}

/**
 * Build an audit entry for a projected cleanup action.
 *
 * All entries are marked `projected: true` — this function NEVER creates
 * real audit records. It exists solely to help the operator understand
 * what would be audited.
 */
export function projectCleanupAuditEntry(
  action: string,
  candidateIds: string[],
  result: CleanupAuditEntry["result"],
  notes: string,
  options: { now?: () => number } = {},
): CleanupAuditEntry {
  const now = options.now ?? Date.now;
  return {
    timestamp: now(),
    action,
    candidateIds,
    result,
    notes,
    projected: true,
  };
}

/**
 * Build a projected rollback/abort summary for the operator.
 *
 * Returns structured notes the operator can use if cleanup produces
 * unexpected side effects. This is a projection artifact — it does not
 * execute or schedule any rollback.
 */
export function buildCleanupRollbackSummary(
  plan: CleanupDryRunPlanProjection,
): {
  runbook: string;
  affectedCandidates: number;
  criticalSteps: string[];
  projectedOnly: true;
} {
  const criticalSteps = plan.steps
    .filter((s) => s.riskClass === "high" || s.riskClass === "blocked")
    .map((s) => s.stepId);

  const affectedCandidates = plan.steps.reduce(
    (sum, s) => sum + s.candidateIds.length,
    0,
  );

  return {
    runbook: plan.rollbackRunbook,
    affectedCandidates,
    criticalSteps,
    projectedOnly: true,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function riskOrdinal(risk: CleanupRiskClass): number {
  switch (risk) {
    case "safe":
      return 0;
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
    case "blocked":
      return 4;
  }
}
