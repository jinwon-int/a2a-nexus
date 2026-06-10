/**
 * Cleanup-candidate summary contract — operator-facing read-only summary
 * of cleanup discovery, dry-run plan, outbox backlog, and worker hygiene.
 *
 * Issue:  jinwon-int/plugin-a2a#401
 * Parent: jinwon-int/a2a-broker#898
 *
 * This module defines an operator-facing summary contract that assembles
 * existing projection types into a single read-only snapshot.  It imports
 * projection types from `cleanup-dry-run-projection.ts` and composes them
 * with outbox/hygiene data that the discovery/plan projections do not cover.
 *
 * ## Semantic invariants
 *
 * 1. **dry-run candidates must not imply mutation** — every returned contract
 *    has `dryRun: true` and `dryRunImpliesMutation: false`.  The summary line
 *    begins with "DRY-RUN" when candidates exist.
 *
 * 2. **unacked terminal outbox backlog must stay separate from ACK/replay** —
 *    `outboxBacklog.unackedCount` tracks records NOT acknowledged.
 *    `outboxBacklog.ackReplayEligibleCount` tracks records eligible for replay.
 *    These are ALWAYS separate properties that MUST NOT be summed.
 *
 * 3. **hot-table warnings compact** — single-line category/severity/message
 *    entries, deduplicated by (category, message) with highest severity kept.
 *
 * 4. **stale worker/residue counts bounded** — counts capped at `MAX_DISPLAY`
 *    (100) with `overflow: true` when the real count exceeds the cap.
 *
 * 5. **missing or invalid required fields fail closed** — `validation.valid === false`
 *    with named missing fields and a "FAIL CLOSED" summary prefix. Includes
 *    `cleanupActionType` and `approvalMode` as required fields with explicit
 *    valid-value sets.
 *
 * ## Safety invariants
 *
 * - Pure projection — no live send, no DB mutation, no terminal ACK,
 *   no Gateway restart, no provider send.
 * - `outboxBacklog` always separates unacked from ack-replay-eligible.
 * - Warnings deduplicated by category+message.
 * - No secrets, host paths, or internal runtime state exposed.
 */

import {
  type CleanupCandidateDiscoveryProjection,
  type CleanupDryRunPlanProjection,
  type CleanupRiskClass,
} from "./cleanup-dry-run-projection.js";

// ── Schema identifier ──────────────────────────────────────────────

/** Schema identifier for the cleanup-candidate summary contract. */
export const A2A_CLEANUP_CANDIDATE_SUMMARY_SCHEMA =
  "a2a.cleanup.candidate-summary.v1" as const;

// ── Sub-types ──────────────────────────────────────────────────────

/**
 * Outbox backlog status — unacknowledged terminal records vs.
 * ACK/replay-eligible records, kept in SEPARATE properties.
 */
export type TerminalOutboxBacklogStatus = {
  /** Unacknowledged terminal outbox records — NOT eligible for ACK/replay. */
  unackedCount: number;
  /** Records eligible for ACK/replay — SEPARATE from unacked backlog. */
  ackReplayEligibleCount: number;
  /** Legacy pre-contract ACK records (separate counter for safety). */
  legacyAckCount: number;
  /** Reminder that unacked and ack/replay are always separate. */
  note: string;
};

/**
 * A single compact hot-table warning.
 *
 * Properties are deliberately single-line / minimal so the operator
 * can scan many warnings quickly.
 */
export type CompactWarning = {
  /** Warning category (e.g. "queue-depth", "stale-workers", "audit-pressure"). */
  category: string;
  /** Single-line message (target < 120 characters). */
  message: string;
  /** Severity for operator triage. */
  severity: "info" | "warn" | "error";
};

/**
 * A bounded count that caps at `MAX_DISPLAY` and signals overflow.
 */
export type BoundedCount = {
  count: number;
  maxDisplay: number;
  overflow: boolean;
  bounded: true;
};

/**
 * Bundle of bounded stale-worker and orphaned-residue counts.
 */
export type StaleWorkerResidueCounts = {
  /** Stale worker registrations (bounded). */
  staleWorkers: BoundedCount;
  /** Orphaned residue / stale session records (bounded). */
  orphanedResidues: BoundedCount;
  /** Unlinked / dangling task records (bounded). */
  unlinkedTasks: BoundedCount;
};

/**
 * Validation result — fails closed when required fields are missing
 * or have invalid values.
 */
export type SummaryContractValidation = {
  valid: boolean;
  /** Names of missing required fields, if any. */
  missingFields: string[];
  /**
   * Human-readable fail-closed message.
   * Present when `valid === false`.
   */
  failClosedMessage?: string;
};

// ── Cleanup action type ────────────────────────────────────────────

/**
 * Valid cleanup action types for the summary contract.
 *
 * Each value represents a category of cleanup operation:
 * - `"prune"` — delete stale/completed records
 * - `"archive"` — move records to cold storage
 * - `"reconcile"` — cross-reference and adjust state
 * - `"notify"` — send operator/owner notifications about residue
 * - `"review"` — flag for manual operator review
 */
export type CleanupActionType =
  | "prune"
  | "archive"
  | "reconcile"
  | "notify"
  | "review";

/** Set of all valid cleanup action type strings. */
const VALID_CLEANUP_ACTION_TYPES: ReadonlySet<string> = new Set<CleanupActionType>([
  "prune",
  "archive",
  "reconcile",
  "notify",
  "review",
]);

// ── Approval mode ──────────────────────────────────────────────────

/**
 * Valid approval modes for the summary contract.
 *
 * Each value represents how operator approval is obtained:
 * - `"explicit"` — operator must explicitly confirm via receipt
 * - `"confirmed"` — operator has pre-confirmed via policy
 * - `"manual"` — operator will handle manually outside the system
 *
 * NEVER defaults to "auto" or produces warning-only behavior.
 */
export type ApprovalMode =
  | "explicit"
  | "confirmed"
  | "manual";

/** Set of all valid approval mode strings. */
const VALID_APPROVAL_MODES: ReadonlySet<string> = new Set<ApprovalMode>([
  "explicit",
  "confirmed",
  "manual",
]);

// ── Main contract type ─────────────────────────────────────────────

/**
 * Operator-facing cleanup-candidate summary contract.
 *
 * Combines cleanup discovery, dry-run plan status, outbox backlog,
 * compact warnings, and bounded stale-worker/residue counts into one
 * read-only snapshot.
 */
export type CleanupCandidateSummaryContract = {
  /** Schema identifier — "a2a.cleanup.candidate-summary.v1". */
  schema: typeof A2A_CLEANUP_CANDIDATE_SUMMARY_SCHEMA;
  /** Run identifier. */
  runId: string;
  /** When the summary was produced (epoch ms). */
  producedAt: number;
  /** Is this a dry-run projection? Always true. */
  dryRun: true;
  /** Do dry-run candidates imply mutation? Always false. */
  dryRunImpliesMutation: false;

  /** Cleanup candidate overview (sourced from discovery + plan projections). */
  overview: {
    totalCandidates: number;
    totalSteps: number;
    operatorGatedSteps: number;
    blockedSteps: number;
    countsByRisk: Record<CleanupRiskClass, number>;
  };

  /** Unacked terminal outbox backlog (SEPARATE from ACK/replay). */
  outboxBacklog: TerminalOutboxBacklogStatus;

  /** Compact hot-table warnings. */
  warnings: CompactWarning[];

  /** Bounded stale worker / residue counts. */
  staleCounts: StaleWorkerResidueCounts;

  /**
   * Cleanup action type — what kind of action this summary describes.
   * Required; missing or invalid values fail closed.
   */
  cleanupActionType: string;
  /**
   * Approval mode — how operator approval is obtained.
   * Required; missing or invalid values fail closed.
   */
  approvalMode: string;

  /** Validation gate — fails closed on missing or invalid required fields. */
  validation: SummaryContractValidation;

  /** Human-readable summary line for operator display. */
  summary: string;
};

// ── Input type ─────────────────────────────────────────────────────

/**
 * Input for building a cleanup-candidate summary contract.
 *
 * Accepts the existing projection types (`discovery`, `plan`) plus
 * additional outbox/hygiene data.  Fields derived from projections
 * are read from them when provided, with individual field overrides
 * taking precedence.
 */
export type CleanupCandidateSummaryInput = {
  /**
   * Existing cleanup discovery projection (optional).
   * When provided, `totalCandidates` and `countsByRisk` are derived
   * from this projection unless explicitly overridden.
   */
  discovery?: CleanupCandidateDiscoveryProjection;

  /**
   * Existing dry-run plan projection (optional).
   * When provided, `totalSteps`, `operatorGatedSteps`, and
   * `blockedSteps` are derived from this projection unless
   * explicitly overridden.
   */
  plan?: CleanupDryRunPlanProjection;

  // ── Individual field overrides / standalone values ─────────────────

  /** Run identifier (required for valid contract). */
  runId?: string;
  /** Total discovered cleanup candidates. */
  totalCandidates?: number;
  /** Total steps in the dry-run plan. */
  totalSteps?: number;
  /** Operator-gated steps count. */
  operatorGatedSteps?: number;
  /** Blocked steps count. */
  blockedSteps?: number;
  /** Counts by risk class. */
  countsByRisk?: Record<CleanupRiskClass, number>;
  /** Unacknowledged terminal outbox records count. */
  unackedOutboxCount?: number;
  /** ACK/replay-eligible records count. */
  ackReplayEligibleCount?: number;
  /** Legacy pre-contract ACK records count (defaults to 0). */
  legacyAckCount?: number;
  /** Stale worker registrations count. */
  staleWorkerCount?: number;
  /** Orphaned residue records count. */
  orphanedResidueCount?: number;
  /** Unlinked task records count. */
  unlinkedTaskCount?: number;

  /**
   * Cleanup action type — what kind of action this summary describes.
   * Required for valid contract; missing or invalid values fail closed.
   */
  cleanupActionType?: string;

  /**
   * Approval mode — how operator approval is obtained.
   * Required for valid contract; missing or invalid values fail closed.
   * Must be one of: "explicit", "confirmed", "manual".
   * NEVER defaults to "auto" or produces warning-only behavior.
   */
  approvalMode?: string;
  /** Queue depth hint for hot-table compaction. */
  queueDepth?: number;
  /** Audit table fullness ratio (0.0–1.0). */
  auditPressureRatio?: number;
  /** Receipt gap count for hot-table compaction. */
  receiptGapCount?: number;
};

// ── Constants ──────────────────────────────────────────────────────

/** Maximum count before `overflow` is set to true. */
const MAX_DISPLAY = 100;

/** Severity ordering for compaction — error > warn > info. */
const SEVERITY_ORDER: Record<CompactWarning["severity"], number> = {
  error: 3,
  warn: 2,
  info: 1,
};

// ── Required fields (always fail-closed when missing) ──────────────

const REQUIRED_FIELDS: ReadonlySet<string> = new Set([
  "runId",
  "totalCandidates",
  "totalSteps",
  "operatorGatedSteps",
  "blockedSteps",
  "countsByRisk",
  "unackedOutboxCount",
  "ackReplayEligibleCount",
  "staleWorkerCount",
  "orphanedResidueCount",
  "unlinkedTaskCount",
  "cleanupActionType",
  "approvalMode",
]);

// ── Public API ──────────────────────────────────────────────────────

/**
 * Build the operator-facing cleanup-candidate summary contract.
 *
 * Pure projection — never implies mutation, never sends, never mutates.
 * Always returns a well-formed contract; when required fields are missing
 * the contract is produced in a fail-closed state.
 *
 * @param input — cleanup discovery/plan projections plus outbox/hygiene data.
 * @returns A complete CleanupCandidateSummaryContract (fail-closed when
 *   required fields are missing).
 */
export function buildCleanupCandidateSummary(
  input: CleanupCandidateSummaryInput,
): CleanupCandidateSummaryContract {
  // Resolve input values: projection-derived fields take precedence
  // from projections when not explicitly overridden.
  const resolved = resolveInput(input);

  // ── Fail-closed validation ─────────────────────────────────
  const validation = validateInput(resolved);

  if (!validation.valid) {
    return buildFailClosedContract(validation, resolved);
  }

  // ── Bounded counts ─────────────────────────────────────────
  const staleCounts = buildBoundedStaleCounts(resolved);

  // ── Outbox backlog (SEPARATE from ACK/replay) ──────────────
  const outboxBacklog = buildOutboxBacklog(resolved);

  // ── Compact hot-table warnings ─────────────────────────────
  const warnings = buildCompactWarnings(resolved);

  // ── Overview ───────────────────────────────────────────────
  const overview = {
    totalCandidates: resolved.totalCandidates!,
    totalSteps: resolved.totalSteps!,
    operatorGatedSteps: resolved.operatorGatedSteps!,
    blockedSteps: resolved.blockedSteps!,
    countsByRisk: sanitizeCountsByRisk(resolved.countsByRisk!),
  };

  // ── Summary ────────────────────────────────────────────────
  const summary = buildSummaryLine(overview, outboxBacklog, staleCounts);

  return {
    schema: A2A_CLEANUP_CANDIDATE_SUMMARY_SCHEMA,
    runId: resolved.runId!,
    producedAt: Date.now(),
    dryRun: true,
    dryRunImpliesMutation: false,
    overview,
    outboxBacklog,
    warnings,
    staleCounts,
    cleanupActionType: resolved.cleanupActionType!,
    approvalMode: resolved.approvalMode!,
    validation,
    summary,
  };
}

// ── Input resolution ───────────────────────────────────────────────

/**
 * Resolve input, deriving fields from projection types when individual
 * fields are not provided.
 *
 * Explicit raw field values always take precedence over projection-derived
 * values.
 */
function resolveInput(input: CleanupCandidateSummaryInput): CleanupCandidateSummaryInput {
  const out: Record<string, unknown> = {};

  // Only set a field if not already set via an explicit raw value.
  const setIfMissing = (key: string, value: unknown) => {
    if (!(key in out) && value !== undefined && value !== null) {
      out[key] = value;
    }
  };

  // Derive from discovery projection (lowest priority)
  if (input.discovery) {
    setIfMissing("runId", input.discovery.runId);
    setIfMissing("totalCandidates", input.discovery.totalCandidates);
    setIfMissing("countsByRisk", input.discovery.countsByRisk as Record<CleanupRiskClass, number>);
  }

  // Derive from plan projection (middle priority)
  if (input.plan) {
    setIfMissing("runId", input.plan.runId);
    setIfMissing("totalSteps", input.plan.totalSteps);
    setIfMissing("operatorGatedSteps", input.plan.operatorGatedSteps);
    setIfMissing("blockedSteps", input.plan.blockedSteps);
  }

  // Copy all explicitly provided fields (highest priority — overwrites projections).
  // Pass through plan and discovery references for downstream consumers
  // (e.g., buildCompactWarnings needs plan.steps for blocked-step messages).
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }

  return out as CleanupCandidateSummaryInput;
}

// ── Internal helpers ───────────────────────────────────────────────

/**
 * Validate required fields — fails closed when any are missing.
 */
function validateInput(
  input: CleanupCandidateSummaryInput,
): SummaryContractValidation {
  const missingFields: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (value === undefined || value === null || value === "") {
      missingFields.push(field);
    }
  }

  if (missingFields.length === 0) {
    // Also validate that cleanupActionType and approvalMode have valid values
    const actionType = (input as Record<string, unknown>)["cleanupActionType"] as string;
    const approvalMode = (input as Record<string, unknown>)["approvalMode"] as string;

    if (actionType && !VALID_CLEANUP_ACTION_TYPES.has(actionType)) {
      return {
        valid: false,
        missingFields: [],
        failClosedMessage: `Invalid cleanupActionType "${actionType}". ` +
          `Must be one of: ${[...VALID_CLEANUP_ACTION_TYPES].join(", ")}. ` +
          `Summary contract is FAIL CLOSED — no cleanup operation can proceed.`,
      };
    }

    if (approvalMode && !VALID_APPROVAL_MODES.has(approvalMode)) {
      return {
        valid: false,
        missingFields: [],
        failClosedMessage: `Invalid approvalMode "${approvalMode}". ` +
          `Must be one of: ${[...VALID_APPROVAL_MODES].join(", ")}. ` +
          `Summary contract is FAIL CLOSED — no cleanup operation can proceed.`,
      };
    }

    return { valid: true, missingFields: [] };
  }

  return {
    valid: false,
    missingFields,
    failClosedMessage: `Missing required field(s): ${missingFields.join(", ")}. ` +
      `Summary contract is FAIL CLOSED — no cleanup operation can proceed.`,
  };
}

/**
 * Build a fail-closed contract when validation fails.
 */
function buildFailClosedContract(
  validation: SummaryContractValidation,
  input: CleanupCandidateSummaryInput,
): CleanupCandidateSummaryContract {
  const runId = input.runId ?? "unknown";
  const failClosedMessage = validation.failClosedMessage!;

  return {
    schema: A2A_CLEANUP_CANDIDATE_SUMMARY_SCHEMA,
    runId,
    producedAt: Date.now(),
    dryRun: true,
    dryRunImpliesMutation: false,
    overview: {
      totalCandidates: 0,
      totalSteps: 0,
      operatorGatedSteps: 0,
      blockedSteps: 0,
      countsByRisk: { safe: 0, low: 0, medium: 0, high: 0, blocked: 0 },
    },
    outboxBacklog: {
      unackedCount: 0,
      ackReplayEligibleCount: 0,
      legacyAckCount: 0,
      note: "Unavailable — contract is fail-closed.",
    },
    warnings: [
      {
        category: "validation",
        message: `FAIL CLOSED: ${failClosedMessage}`,
        severity: "error",
      },
    ],
    staleCounts: {
      staleWorkers: { count: 0, maxDisplay: MAX_DISPLAY, overflow: false, bounded: true },
      orphanedResidues: { count: 0, maxDisplay: MAX_DISPLAY, overflow: false, bounded: true },
      unlinkedTasks: { count: 0, maxDisplay: MAX_DISPLAY, overflow: false, bounded: true },
    },
    cleanupActionType: "",
    approvalMode: "",
    validation,
    summary: `FAIL CLOSED: ${failClosedMessage}`,
  };
}

/**
 * Build the terminal outbox backlog, keeping unacked records
 * SEPARATE from ACK/replay-eligible records.
 */
function buildOutboxBacklog(
  input: CleanupCandidateSummaryInput,
): TerminalOutboxBacklogStatus {
  return {
    unackedCount: clampNonNegative(input.unackedOutboxCount ?? 0),
    ackReplayEligibleCount: clampNonNegative(input.ackReplayEligibleCount ?? 0),
    legacyAckCount: clampNonNegative(input.legacyAckCount ?? 0),
    note: "Unacked terminal outbox backlog is kept SEPARATE from ACK/replay-eligible records. " +
      "These MUST NOT be summed or conflated. ACK/replay eligibility requires explicit operator " +
      "receipt confirmation, not provider delivery status.",
  };
}

/**
 * Build bounded stale worker / residue / unlinked counts.
 */
function buildBoundedStaleCounts(
  input: CleanupCandidateSummaryInput,
): StaleWorkerResidueCounts {
  return {
    staleWorkers: toBoundedCount(clampNonNegative(input.staleWorkerCount ?? 0)),
    orphanedResidues: toBoundedCount(clampNonNegative(input.orphanedResidueCount ?? 0)),
    unlinkedTasks: toBoundedCount(clampNonNegative(input.unlinkedTaskCount ?? 0)),
  };
}

/**
 * Build compact hot-table warnings.
 *
 * Warnings are de-duplicated by category+message combination, and
 * the most severe level wins when the same category appears with
 * multiple severity signals.
 */
function buildCompactWarnings(
  input: CleanupCandidateSummaryInput,
): CompactWarning[] {
  const candidates: CompactWarning[] = [];

  // ── Approval mode info ─────────────────────────────────
  // Approval mode is validated at the input level and fails closed
  // when missing or invalid.  This is informational only, never a
  // warning — the contract already rejected invalid modes above.
  // No default-to-auto or auto-accept behavior.

  // ── Queue depth hot table ──────────────────────────────
  const queueDepth = input.queueDepth ?? 0;
  if (queueDepth >= 100) {
    candidates.push({
      category: "queue-depth",
      message: `Queue depth at ${queueDepth} — hot table, max safe level is 100.`,
      severity: "error",
    });
  } else if (queueDepth >= 50) {
    candidates.push({
      category: "queue-depth",
      message: `Queue depth at ${queueDepth} — elevated.`,
      severity: "warn",
    });
  } else if (queueDepth >= 20) {
    candidates.push({
      category: "queue-depth",
      message: `Queue depth at ${queueDepth}.`,
      severity: "info",
    });
  }

  // ── Audit pressure ─────────────────────────────────────
  const auditPressure = input.auditPressureRatio ?? 0;
  if (auditPressure >= 0.95) {
    candidates.push({
      category: "audit-pressure",
      message: `Audit table at ${toPercent(auditPressure)} — near capacity.`,
      severity: "error",
    });
  } else if (auditPressure >= 0.9) {
    candidates.push({
      category: "audit-pressure",
      message: `Audit table at ${toPercent(auditPressure)} — elevated.`,
      severity: "warn",
    });
  } else if (auditPressure >= 0.75) {
    candidates.push({
      category: "audit-pressure",
      message: `Audit table at ${toPercent(auditPressure)}.`,
      severity: "info",
    });
  }

  // ── Receipt gaps ───────────────────────────────────────
  const receiptGaps = input.receiptGapCount ?? 0;
  if (receiptGaps > 10) {
    candidates.push({
      category: "receipt-gaps",
      message: `${receiptGaps} receipt gap(s) — may require manual review.`,
      severity: "error",
    });
  } else if (receiptGaps > 0) {
    candidates.push({
      category: "receipt-gaps",
      message: `${receiptGaps} receipt gap(s).`,
      severity: "warn",
    });
  }

  // ── Stale worker overflow ──────────────────────────────
  if ((input.staleWorkerCount ?? 0) > MAX_DISPLAY) {
    candidates.push({
      category: "stale-workers",
      message: `Stale worker count (${input.staleWorkerCount}) exceeds display limit — overflow.`,
      severity: "warn",
    });
  }

  // ── Orphaned residue overflow ──────────────────────────
  if ((input.orphanedResidueCount ?? 0) > MAX_DISPLAY) {
    candidates.push({
      category: "orphaned-residues",
      message: `Orphaned residue count (${input.orphanedResidueCount}) exceeds display limit — overflow.`,
      severity: "warn",
    });
  }

  // ── Unlinked task overflow ─────────────────────────────
  if ((input.unlinkedTaskCount ?? 0) > MAX_DISPLAY) {
    candidates.push({
      category: "unlinked-tasks",
      message: `Unlinked task count (${input.unlinkedTaskCount}) exceeds display limit — overflow.`,
      severity: "warn",
    });
  }

  // ── Blocked or high risk candidates (from plan) ──────────
  if (input.plan?.steps.some((s) => s.blocked)) {
    candidates.push({
      category: "blocked-candidates",
      message: "Blocked candidates present — may reference valid home-broker records.",
      severity: "error",
    });
  }

  // ── Deduplicate by category+message, keep highest severity ──
  return deduplicateWarnings(candidates);
}

/**
 * Build the human-readable summary line.
 *
 * When candidates exist, the summary starts with "DRY-RUN" to
 * make it impossible to miss that no mutation has occurred.
 */
function buildSummaryLine(
  overview: CleanupCandidateSummaryContract["overview"],
  outboxBacklog: TerminalOutboxBacklogStatus,
  staleCounts: StaleWorkerResidueCounts,
): string {
  const parts: string[] = [];

  if (overview.totalCandidates === 0) {
    parts.push("No cleanup candidates.");
  } else {
    parts.push(
      `DRY-RUN: ${overview.totalCandidates} candidate(s), ` +
      `${overview.totalSteps} step(s) ` +
      `(${overview.operatorGatedSteps} operator-gated, ${overview.blockedSteps} blocked).`,
    );
  }

  parts.push(
    `Unacked outbox backlog: ${outboxBacklog.unackedCount} (separate from ACK/replay: ${outboxBacklog.ackReplayEligibleCount}).`,
  );

  const staleTotal =
    staleCounts.staleWorkers.count +
    staleCounts.orphanedResidues.count +
    staleCounts.unlinkedTasks.count;
  if (staleTotal > 0) {
    parts.push(
      `Stale/residue: ${staleCounts.staleWorkers.count} worker(s), ` +
      `${staleCounts.orphanedResidues.count} residue(s), ` +
      `${staleCounts.unlinkedTasks.count} unlinked task(s).`,
    );
  } else {
    parts.push("No stale/residue records.");
  }

  parts.push("Dry-run only — no mutation has occurred.");

  return parts.join(" ");
}

/**
 * Deduplicate warnings by category+message, keeping the highest severity
 * for duplicates.
 */
function deduplicateWarnings(
  candidates: CompactWarning[],
): CompactWarning[] {
  const seen = new Map<string, CompactWarning>();

  for (const w of candidates) {
    const key = `${w.category}:${w.message}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, w);
    } else {
      if (SEVERITY_ORDER[w.severity] > SEVERITY_ORDER[existing.severity]) {
        seen.set(key, w);
      }
    }
  }

  return [...seen.values()];
}

/**
 * Cap a non-negative number at MAX_DISPLAY and signal overflow.
 */
function toBoundedCount(value: number): BoundedCount {
  return {
    count: Math.min(value, MAX_DISPLAY),
    maxDisplay: MAX_DISPLAY,
    overflow: value > MAX_DISPLAY,
    bounded: true,
  };
}

/**
 * Clamp a value to non-negative.
 */
function clampNonNegative(value: number): number {
  return Math.max(0, Math.trunc(value));
}

/**
 * Sanitize countsByRisk — ensure known risk keys exist and all values
 * are non-negative numbers.
 */
function sanitizeCountsByRisk(
  raw: Record<string, unknown>,
): Record<CleanupRiskClass, number> {
  const knownKeys: CleanupRiskClass[] = ["safe", "low", "medium", "high", "blocked"];
  const result: Record<string, number> = {};

  for (const key of knownKeys) {
    const val = raw[key];
    result[key] = typeof val === "number" && Number.isFinite(val) && val >= 0
      ? Math.trunc(val)
      : 0;
  }

  return result as Record<CleanupRiskClass, number>;
}

/**
 * Format a ratio (0.0–1.0) as a percentage string.
 */
function toPercent(ratio: number): string {
  const pct = Math.trunc(ratio * 100);
  return `${pct}%`;
}
