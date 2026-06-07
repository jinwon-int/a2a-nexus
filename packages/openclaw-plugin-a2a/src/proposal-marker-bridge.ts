/**
 * Proposal marker bridge (Round 19, plugin-a2a#94).
 *
 * Bridges worker/conference markers into broker proposal lifecycle events.
 * Extends the Round 18 teleconference bridge with proposal-specific semantics:
 * proposed → blocked → approved → rejected → applying → applied → failed.
 *
 * Key properties:
 * - Idempotent: stable proposal event IDs derived from source.
 * - Privacy: no raw prompt/session text forwarded by default.
 * - Safe: malformed/missing proposal refs → skip/warning, never crash.
 * - Zero OpenClaw internals imported.
 *
 * Depends on:
 * - worker-status-marker.ts (Round 16)
 * - worker-marker-ingestion.ts (Round 17)
 * - conference-marker-bridge.ts (Round 18)
 */

import { createHash } from "node:crypto";

import {
  type WorkerStatusEvent,
  type WorkerStatusMarkerType,
  WorkerStatusMarker,
} from "./worker-status-marker.js";
import {
  type GitHubCommentSource,
  type DeduplicationStore,
} from "./worker-marker-ingestion.js";
import {
  ConferenceDeduplicationStore,
  deriveConferenceId,
} from "./conference-marker-bridge.js";

// ── Proposal lifecycle types ───────────────────────────────────

export const ProposalState = {
  PROPOSED: "proposed",
  BLOCKED: "blocked",
  APPROVED: "approved",
  REJECTED: "rejected",
  APPLYING: "applying",
  APPLIED: "applied",
  FAILED: "failed",
} as const;

export type ProposalStateType = (typeof ProposalState)[keyof typeof ProposalState];

export const PROPOSAL_TRANSITION_REASON = {
  WORKER_STARTED: "worker_started",
  WORKER_BLOCKED: "worker_blocked",
  PR_SUBMITTED: "pr_submitted",
  PR_APPROVED: "pr_approved",
  PR_REJECTED: "pr_rejected",
  APPLY_STARTED: "apply_started",
  APPLY_SUCCEEDED: "apply_succeeded",
  APPLY_FAILED: "apply_failed",
  PROPOSAL_CREATED: "proposal_created",
  PROPOSAL_DUPLICATED: "proposal_duplicated",
} as const;

export type ProposalTransitionReason =
  (typeof PROPOSAL_TRANSITION_REASON)[keyof typeof PROPOSAL_TRANSITION_REASON];

// ── Proposal event shape ───────────────────────────────────────

export interface ProposalLifecycleEvent {
  /** Stable event ID for idempotency. */
  eventId: string;
  /** Proposal identifier, derived from task + conference. */
  proposalId: string;
  /** Parent task id this proposal addresses. */
  taskId: string;
  /** Conference room this proposal originated from. */
  conferenceId: string;
  /** Current proposal state. */
  state: ProposalStateType;
  /** Reason for the state transition. */
  transitionReason: ProposalTransitionReason;
  /** The participant/worker that triggered this transition. */
  participantId: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Redacted proposal summary (never raw prompt/session text). */
  summary?: string;
  /** Related artifact (PR URL, issue URL, etc.). */
  artifactUrl?: string;
  /** Source identifiers for traceability. */
  source: {
    repository?: string;
    issueNumber?: number;
    commentId?: number;
  };
  /** Parse status. */
  parseStatus: "clean" | "partial";
  /** Non-fatal warnings. */
  warnings: string[];
}

// ── Marker → proposal state mapping ────────────────────────────

const MARKER_TO_PROPOSAL_STATE: Partial<
  Record<WorkerStatusMarkerType, { state: ProposalStateType; reason: ProposalTransitionReason }>
> = {
  [WorkerStatusMarker.START]: {
    state: ProposalState.PROPOSED,
    reason: PROPOSAL_TRANSITION_REASON.WORKER_STARTED,
  },
  [WorkerStatusMarker.BLOCK]: {
    state: ProposalState.BLOCKED,
    reason: PROPOSAL_TRANSITION_REASON.WORKER_BLOCKED,
  },
  [WorkerStatusMarker.PR]: {
    state: ProposalState.APPLYING,
    reason: PROPOSAL_TRANSITION_REASON.PR_SUBMITTED,
  },
  [WorkerStatusMarker.DONE]: {
    state: ProposalState.APPLIED,
    reason: PROPOSAL_TRANSITION_REASON.APPLY_SUCCEEDED,
  },
};

// ── Redaction / summary extraction ─────────────────────────────

const REDACTED = "[redacted]";
const MAX_SUMMARY_LENGTH = 300;

const PRIVATE_PATTERNS = [
  /\b(?:raw\s+)?(?:session|prompt|transcript|conversation|chat\s*log)\s*[:：].*$/im,
  /\bprivate\s+(?:data|text|session|prompt)\s*[:：]?.*$/im,
];

const SECRET_PATTERN =
  /\b(api[_ -]?key|token|secret|password|authorization|bearer)\b\s*[:=]\s*[^\s,;]+/gi;

function redactSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  let result = trimmed.replace(/```[\s\S]*?```/g, REDACTED);
  for (const pat of PRIVATE_PATTERNS) {
    result = result.replace(pat, REDACTED);
  }
  result = result.replace(SECRET_PATTERN, `$1: ${REDACTED}`);
  result = result.replace(/\s+/g, " ").trim();
  result = result.replace(/(?:\s*\[redacted\]){2,}/g, ` ${REDACTED}`).trim();

  if (!result) return REDACTED;
  return result.length > MAX_SUMMARY_LENGTH
    ? `${result.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`
    : result;
}

function extractProposalSummary(event: WorkerStatusEvent): string | undefined {
  const p = event.payload as Record<string, unknown>;
  switch (event.marker) {
    case "Start": return redactSummary(p.summary);
    case "Block": return redactSummary(p.reason);
    case "PR": {
      const parts: string[] = [];
      const vs = redactSummary(p.verificationSummary);
      if (vs) parts.push(vs);
      if (typeof p.branch === "string" && p.branch.trim()) {
        parts.push(`branch: ${p.branch.trim()}`);
      }
      return parts.length > 0 ? parts.join("; ") : undefined;
    }
    case "Done": return redactSummary(p.completionSummary);
    default: return undefined;
  }
}

function extractArtifactUrl(event: WorkerStatusEvent): string | undefined {
  const p = event.payload as Record<string, unknown>;
  for (const c of [p.prUrl, p.issueUrl, p.doneUrl, p.blockUrl]) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return undefined;
}

// ── Proposal ID derivation ─────────────────────────────────────

/**
 * Derive a stable proposal ID from task + conference context.
 */
export function deriveProposalId(taskId: string, conferenceId: string): string {
  const raw = `proposal:${taskId}:${conferenceId}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

// ── Bridge result types ────────────────────────────────────────

export interface ProposalBridgeSuccess {
  ok: true;
  event: ProposalLifecycleEvent;
}

export interface ProposalBridgeSkip {
  ok: true;
  skipped: true;
  reason: string;
}

export interface ProposalBridgeError {
  ok: false;
  error: string;
}

export type ProposalBridgeResult =
  | ProposalBridgeSuccess
  | ProposalBridgeSkip
  | ProposalBridgeError;

// ── Proposal deduplication store ───────────────────────────────

export class ProposalDeduplicationStore {
  private seen = new Map<string, ProposalStateType>();
  private maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  /** Record event. Returns true if this was a new entry, false if duplicate. */
  add(eventId: string, state: ProposalStateType): boolean {
    if (this.seen.has(eventId)) return false;
    if (this.seen.size >= this.maxSize) {
      const iter = this.seen.keys();
      const toRemove = Math.floor(this.maxSize * 0.1);
      for (let i = 0; i < toRemove; i++) {
        const entry = iter.next();
        if (entry.done) break;
        this.seen.delete(entry.value);
      }
    }
    this.seen.set(eventId, state);
    return true;
  }

  /** Get the last recorded state for an event ID. */
  getState(eventId: string): ProposalStateType | undefined {
    return this.seen.get(eventId);
  }

  clear(): void {
    this.seen.clear();
  }
}

// ── Stable ID helpers ──────────────────────────────────────────

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((e) => stableStringify(e)).join(",")}]`;
  }
  const r = value as Record<string, unknown>;
  return `{${Object.keys(r)
    .sort()
    .filter((k) => r[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(r[k])}`)
    .join(",")}}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")
    .slice(0, 16);
}

// ── Main bridge function ───────────────────────────────────────

/**
 * Bridge a worker status event into a proposal lifecycle event.
 */
export function bridgeWorkerEventToProposal(
  event: WorkerStatusEvent,
  conferenceId: string,
  dedupStore: ProposalDeduplicationStore,
  source?: { repository?: string; issueNumber?: number; commentId?: number },
): ProposalBridgeResult {
  // 1. Resolve marker → proposal state
  const mapping = MARKER_TO_PROPOSAL_STATE[event.marker];
  if (!mapping) {
    return {
      ok: false,
      error: `marker '${event.marker}' does not map to a proposal state`,
    };
  }

  const { state, reason } = mapping;

  // 2. Derive proposal ID from task + conference
  const proposalId = deriveProposalId(event.taskId, conferenceId);

  // 3. Extract safe summary and artifact
  const summary = extractProposalSummary(event);
  const artifactUrl = extractArtifactUrl(event);

  // 4. Derive stable event ID
  const eventIdBase =
    typeof source?.commentId === "number"
      ? `prop:${proposalId}:${event.workerId}:${source.commentId}:${event.marker.toLowerCase()}`
      : `prop:${proposalId}:${event.workerId}:fallback:${event.marker.toLowerCase()}:${fingerprint({
          marker: event.marker,
          taskId: event.taskId,
          artifactUrl: artifactUrl ?? "",
          summary: summary ?? "",
        })}`;

  // 5. Check deduplication
  if (dedupStore.has(eventIdBase)) {
    return {
      ok: true,
      skipped: true,
      reason: "duplicate proposal event already processed",
    };
  }

  // 6. Build proposal lifecycle event
  const proposalEvent: ProposalLifecycleEvent = {
    eventId: eventIdBase,
    proposalId,
    taskId: event.taskId,
    conferenceId,
    state,
    transitionReason: reason,
    participantId: event.workerId,
    timestamp: event.observedAt,
    ...(summary ? { summary } : {}),
    ...(artifactUrl ? { artifactUrl } : {}),
    source: {
      repository: source?.repository,
      issueNumber: source?.issueNumber,
      commentId: source?.commentId,
    },
    parseStatus: event.parseStatus === "clean" ? "clean" : "partial",
    warnings: [...event.warnings],
  };

  // 7. Record for deduplication
  dedupStore.add(eventIdBase, state);

  return { ok: true, event: proposalEvent };
}

// ── Full pipeline (ingestion + proposal bridge) ────────────────

import { ingestGitHubComment } from "./worker-marker-ingestion.js";

/**
 * Full pipeline: ingest a GitHub comment and bridge to proposal lifecycle event.
 */
export function ingestAndBridgeProposal(
  payload: Record<string, unknown>,
  markerDedupStore: DeduplicationStore,
  proposalDedupStore: ProposalDeduplicationStore,
  options?: {
    loginToWorkerMap?: Record<string, string>;
    allowedActions?: string[];
  },
): ProposalBridgeResult {
  // 1. Ingest the comment (Round 17 pipeline)
  const ingestion = ingestGitHubComment(payload, markerDedupStore, options);

  if (!ingestion.ok) {
    return { ok: false, error: ingestion.error };
  }

  if ("skipped" in ingestion) {
    return { ok: true, skipped: true, reason: ingestion.reason };
  }

  // 2. Derive conference ID from source
  const source = ingestion.source;
  const conferenceId = deriveConferenceId({
    repository: source.repository,
    issueNumber: source.issueNumber,
  });

  // 3. Bridge to proposal lifecycle
  return bridgeWorkerEventToProposal(
    ingestion.workerEvent,
    conferenceId,
    proposalDedupStore,
    {
      repository: source.repository,
      issueNumber: source.issueNumber,
      commentId: source.commentId,
    },
  );
}

/**
 * Batch bridge multiple GitHub comments into proposal lifecycle events.
 */
export function batchIngestAndBridgeProposal(
  payloads: Array<Record<string, unknown>>,
  markerDedupStore: DeduplicationStore,
  proposalDedupStore: ProposalDeduplicationStore,
  options?: {
    loginToWorkerMap?: Record<string, string>;
    allowedActions?: string[];
  },
): {
  results: ProposalBridgeResult[];
  bridged: number;
  skipped: number;
  errors: number;
} {
  const results: ProposalBridgeResult[] = [];
  let bridged = 0;
  let skipped = 0;
  let errors = 0;

  for (const payload of payloads) {
    const result = ingestAndBridgeProposal(
      payload,
      markerDedupStore,
      proposalDedupStore,
      options,
    );
    results.push(result);

    if (!result.ok) errors++;
    else if ("skipped" in result && result.skipped) skipped++;
    else bridged++;
  }

  return { results, bridged, skipped, errors };
}
