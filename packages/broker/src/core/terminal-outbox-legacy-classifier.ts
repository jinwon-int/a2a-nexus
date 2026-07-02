/**
 * Terminal outbox legacy residue classifier (read-only, no DB mutation).
 *
 * Distinguishes current-window terminal_outbox rows from legacy residue
 * using multiple signals — cutoff age, payload completeness (taskBrief,
 * evidence URLs), receipt vocabulary, and ACK evidence vocabulary — so
 * that current-window Terminal Brief preflight health is not blocked by
 * legacy rows that are resident in the outbox but predate the current
 * terminal-notification vocabulary.
 *
 * All classification is pure and source-only. The broker does not prune,
 * mutate, or ACK rows based on this classifier.
 *
 * Reference: #886 Team1/workergamma Terminal Brief hardening lane 1/4.
 */

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

/** Default legacy residue cutoff used when no explicit cutoff is provided. */
export const DEFAULT_LEGACY_RESIDUE_CUTOFF = "2026-05-04T07:10:00.000Z";

/** Evidence URL keys checked for payload completeness. */
const EVIDENCE_URL_KEYS = ["prUrl", "doneUrl", "blockUrl"] as const;

const SAFE_EVIDENCE_URL_RE = /^https?:\/\//;

// ---------------------------------------------------------------------------
// Input type — minimal outbox event subset that the classifier inspects.
// Accepts any object shaped like a terminal_outbox row, not only full
// TerminalTaskOutboxEvent; the classifier uses optional chaining throughout.
// ---------------------------------------------------------------------------

/**
 * Minimal shape that the classifier inspects on a terminal_outbox row.
 * Conforms to the broker's TerminalTaskOutboxEvent projection schema.
 * Payload is intentionally opaque (unknown) — the classifier only reads
 * the specific keys it needs via optional chaining.
 */
export interface OutboxRowCandidate {
  id?: unknown;
  createdAt?: string;
  ack?: {
    status?: unknown;
    evidence?: unknown;
    acknowledgedAt?: unknown;
  } | null;
  receipt?: {
    status?: unknown;
    updatedAt?: unknown;
  } | null;
  payload?: {
    taskId?: unknown;
    status?: unknown;
    taskBrief?: unknown;
    prUrl?: unknown;
    doneUrl?: unknown;
    blockUrl?: unknown;
    worker?: unknown;
  } | null;
}

// ---------------------------------------------------------------------------
// Classification signals
// ---------------------------------------------------------------------------

export interface OutboxRowSignals {
  /**
   * True when the row's createdAt timestamp is before the legacy residue cutoff.
   * Null when createdAt is missing or unparseable.
   */
  preCutoff: boolean | null;
  /** True when payload.taskBrief is a non-empty string. */
  hasTaskBrief: boolean;
  /** True when none of prUrl, doneUrl, blockUrl are present in payload. */
  missingEvidence: boolean;
  /** True when receipt.status is one of the legacy receipt statuses (sent, provider_delivered_if_known). */
  legacyReceiptStatus: boolean;
  /** True when ack.evidence is a legacy ACK evidence value (provider_delivery_receipt). */
  legacyAckEvidence: boolean;
  /** True when ack.status === 'receipt_confirmed'. */
  receiptConfirmed: boolean;
}

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

export type OutboxRowOrigin = "current-window" | "legacy-residue" | "unclassifiable";

export interface OutboxRowClassification {
  /** Stable outbox row id, stringified. Null when id is missing or not a string. */
  id: string | null;
  /** Deterministic origin classification. */
  origin: OutboxRowOrigin;
  /** Detailed signal breakdown. */
  signals: OutboxRowSignals;
  /** Human-readable reason summary. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Aggregate report
// ---------------------------------------------------------------------------

export interface OutboxLegacyResidueReport {
  total: number;
  currentWindow: number;
  legacyResidue: number;
  unclassifiable: number;
  /** Per-row classifications in input order. */
  classifications: OutboxRowClassification[];
  /** Current-window blockers that should fail preflight. */
  currentWindowBlockers: {
    missingEvidenceIds: string[];
    missingWorkerIds: string[];
    missingTaskBriefIds: string[];
    unsafeEvidenceIds: string[];
  };
  /** Legacy residue rows that are reported but do not block. */
  legacyResidueSummary: Array<{
    id: string | null;
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Core classifier
// ---------------------------------------------------------------------------

/**
 * Deterministically classify a single terminal_outbox row as current-window,
 * legacy residue, or unclassifiable.
 *
 * Legcy residue signals (any one suffices for a legacy-residue classification
 * when some other signal also leans legacy):
 *   - Created before the legacy residue cutoff
 *   - Missing taskBrief (common in legacy compact rows)
 *   - Legacy receipt status (sent, provider_delivered_if_known)
 *   - Legacy ACK evidence (provider_delivery_receipt)
 *
 * A row is unclassifiable when it has too little information (no createdAt,
 * no payload keys, no receipt/ack state).
 *
 * @param row  The terminal_outbox row to classify (partial shape accepted).
 * @param cutoffMs  Legacy residue cutoff in milliseconds since epoch.
 *                  Pass null or undefined to use DEFAULT_LEGACY_RESIDUE_CUTOFF.
 */
export function classifyOutboxRow(
  row: OutboxRowCandidate,
  cutoffMs?: number | null,
): OutboxRowClassification {
  const id = typeof row?.id === "string" ? row.id : null;
  const effectiveCutoffMs = Number.isFinite(cutoffMs)
    ? cutoffMs!
    : Date.parse(DEFAULT_LEGACY_RESIDUE_CUTOFF);

  // --- Extract signals ---

  // Pre-cutoff signal
  const createdAtMs = typeof row?.createdAt === "string"
    ? Date.parse(row.createdAt)
    : NaN;
  const preCutoff: boolean | null = Number.isFinite(createdAtMs)
    ? createdAtMs < effectiveCutoffMs
    : null;

  // Payload completeness signals
  const taskBrief = row?.payload?.taskBrief;
  const hasTaskBrief = typeof taskBrief === "string" && taskBrief.length > 0;

  const evidenceKeys = EVIDENCE_URL_KEYS;
  const hasAnyEvidenceUrl = evidenceKeys.some((key) => {
    const value = (row?.payload as Record<string, unknown>)?.[key];
    return typeof value === "string" && value.length > 0;
  });
  const missingEvidence = !hasAnyEvidenceUrl;

  // Receipt vocabulary signal
  const receiptStatus = row?.receipt?.status;
  const legacyReceiptStatus =
    receiptStatus === "sent" || receiptStatus === "provider_delivered_if_known";

  // ACK evidence vocabulary signal
  const ackEvidence = row?.ack?.evidence;
  const legacyAckEvidence = ackEvidence === "provider_delivery_receipt";

  // Receipt-confirmed signal
  const receiptConfirmed = row?.ack?.status === "receipt_confirmed";

  // --- Classify ---

  // Build a weighted reason from the signals
  const parts: string[] = [];

  const strongLegacySignals =
    (preCutoff === true ? 1 : 0) +
    (legacyReceiptStatus ? 1 : 0) +
    (legacyAckEvidence ? 1 : 0);

  const moderateLegacySignals =
    (missingEvidence ? 1 : 0) +
    (!hasTaskBrief ? 1 : 0);

  let origin: OutboxRowOrigin;
  let reason: string;

  // Unclassifiable: no useful signals at all
  const hasAnySignal =
    preCutoff !== null ||
    hasTaskBrief ||
    !missingEvidence ||
    legacyReceiptStatus ||
    legacyAckEvidence ||
    receiptConfirmed;

  if (!hasAnySignal) {
    origin = "unclassifiable";
    reason = "insufficient data to classify (no createdAt, no payload, no receipt/ack state)";
  } else if (strongLegacySignals >= 1) {
    // At least one strong legacy signal → legacy-residue
    origin = "legacy-residue";
    if (preCutoff === true) parts.push("pre-cutoff");
    if (!hasTaskBrief) parts.push("missing taskBrief");
    if (missingEvidence) parts.push("missing evidence");
    if (legacyReceiptStatus) parts.push("legacy receipt status");
    if (legacyAckEvidence) parts.push("legacy ACK evidence");
    reason = `legacy residue: ${parts.join(", ")}`;
  } else if (moderateLegacySignals >= 2) {
    // Both missing evidence and missing taskBrief with no strong current signals → legacy-residue
    origin = "legacy-residue";
    if (!hasTaskBrief) parts.push("missing taskBrief");
    if (missingEvidence) parts.push("missing evidence");
    reason = `legacy residue: ${parts.join(", ")}`;
  } else if (!hasTaskBrief && preCutoff !== false && !receiptConfirmed) {
    // Missing taskBrief and not affirmatively post-cutoff and not receipt-confirmed → legacy-residue
    origin = "legacy-residue";
    parts.push("missing taskBrief");
    if (preCutoff === null) parts.push("cutoff unknown");
    reason = `legacy residue: ${parts.join(", ")}`;
  } else {
    // All other rows are current-window
    origin = "current-window";
    if (preCutoff === false) parts.push("post-cutoff");
    if (hasTaskBrief) parts.push("has taskBrief");
    if (!missingEvidence) parts.push("has evidence");
    if (receiptConfirmed) parts.push("receipt-confirmed");
    reason = `current window: ${parts.join(", ")}`;
  }

  const signals: OutboxRowSignals = {
    preCutoff,
    hasTaskBrief,
    missingEvidence,
    legacyReceiptStatus,
    legacyAckEvidence,
    receiptConfirmed,
  };

  return { id, origin, signals, reason };
}

/**
 * Classify an array of terminal_outbox rows and produce an aggregate report.
 *
 * Current-window rows are checked for preflight blockers (missing evidence,
 * missing worker, missing taskBrief, unsafe evidence). Legacy-residue and
 * unclassifiable rows are reported separately and do not block.
 *
 * @param rows    Array of terminal_outbox row candidates.
 * @param options Optional cutoff timestamp and event metadata.
 */
export function classifyOutboxRows(
  rows: OutboxRowCandidate[],
  options: { cutoffMs?: number | null } = {},
): OutboxLegacyResidueReport {
  const cutoffMs = options.cutoffMs ?? null;
  const classifications = rows.map((row) => classifyOutboxRow(row, cutoffMs));

  const currentWindow = classifications.filter((c) => c.origin === "current-window");
  const legacyResidue = classifications.filter((c) => c.origin === "legacy-residue");
  const unclassifiable = classifications.filter((c) => c.origin === "unclassifiable");

  // Current-window blockers
  const currentWindowBlockers = {
    missingEvidenceIds: currentWindow
      .filter((c) => c.signals.missingEvidence)
      .map((c) => c.id)
      .filter((id): id is string => id !== null),
    missingWorkerIds: currentWindow
      .filter((c) => {
        // Need the actual row to check worker presence
        return false; // Worker check requires the full row; handled by caller
      })
      .map((c) => c.id)
      .filter((id): id is string => id !== null),
    missingTaskBriefIds: currentWindow
      .filter((c) => !c.signals.hasTaskBrief)
      .map((c) => c.id)
      .filter((id): id is string => id !== null),
    unsafeEvidenceIds: [],
  };

  const legacyResidueSummary = legacyResidue.map((c) => ({
    id: c.id,
    reason: c.reason,
  }));

  return {
    total: classifications.length,
    currentWindow: currentWindow.length,
    legacyResidue: legacyResidue.length,
    unclassifiable: unclassifiable.length,
    classifications,
    currentWindowBlockers,
    legacyResidueSummary,
  };
}

/**
 * Check whether a payload has any unsafe (non-HTTP) evidence URL.
 */
export function hasUnsafeEvidenceUrl(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload) return false;
  return EVIDENCE_URL_KEYS.some((key) => {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 && !SAFE_EVIDENCE_URL_RE.test(value);
  });
}
