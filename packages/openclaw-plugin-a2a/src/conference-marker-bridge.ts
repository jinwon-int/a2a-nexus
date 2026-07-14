/**
 * Teleconference marker bridge (Round 18, plugin-a2a#91).
 *
 * Bridges OpenClaw/A2A worker participation markers into broker
 * teleconference events. Maps worker status markers (Start, Block, PR, Done)
 * into conference participant events with stable source identifiers.
 *
 * Built on Round 16 (worker-status-marker) and Round 17 (worker-marker-ingestion).
 *
 * Key properties:
 * - Idempotent: stable conference event IDs derived from source.
 * - Safe: malformed/missing conference refs → skip/warning, never crash.
 * - Privacy: no raw prompt/session text forwarded by default.
 * - Zero OpenClaw internals imported.
 */

import { createHash } from "node:crypto";

import {
  type WorkerStatusEvent,
  type WorkerStatusMarkerType,
  WorkerStatusMarker,
} from "./worker-status-marker.js";
import {
  type GitHubCommentSource,
  ingestGitHubComment,
  deriveEventId,
  type DeduplicationStore,
} from "./worker-marker-ingestion.js";

// ── Conference event types ─────────────────────────────────────

export type ConferenceParticipantAction =
  | "join"
  | "contribute"
  | "block"
  | "pr"
  | "done"
  | "leave";

export interface ConferenceParticipantEvent {
  /** Stable event ID for idempotency. */
  eventId: string;
  /** Conference room identifier. */
  conferenceId: string;
  /** The participant (worker/agent). */
  participantId: string;
  /** What the participant did. */
  action: ConferenceParticipantAction;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Summary of the contribution (never raw prompt/session text). */
  summary?: string;
  /** Related artifact (e.g., PR URL). */
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

// ── Marker → conference action mapping ─────────────────────────

const MARKER_TO_ACTION: Record<WorkerStatusMarkerType, ConferenceParticipantAction> = {
  [WorkerStatusMarker.START]: "join",
  [WorkerStatusMarker.BLOCK]: "block",
  [WorkerStatusMarker.PR]: "pr",
  [WorkerStatusMarker.DONE]: "done",
};

// ── Conference ID derivation ───────────────────────────────────

/**
 * Derive a conference ID from the source context.
 * Uses repository + issue/PR number as the conference room.
 */
export function deriveConferenceId(source: {
  repository: string;
  issueNumber: number;
}): string {
  return `conference:${source.repository}:${source.issueNumber}`;
}

/**
 * Derive a stable conference event ID from source and marker type.
 * Combines the comment source with the marker to ensure uniqueness
 * while maintaining idempotency for duplicate deliveries.
 */
export function deriveConferenceEventId(
  source: GitHubCommentSource,
  marker: WorkerStatusMarkerType,
): string {
  // Use the base event ID + marker suffix for uniqueness
  const baseId = deriveEventId(source);
  return `${baseId}:${marker.toLowerCase()}`;
}

// ── Summary extraction (privacy-preserving) ────────────────────

const REDACTED_SUMMARY = "[redacted]";
const MAX_SAFE_SUMMARY_LENGTH = 300;

const INLINE_PRIVATE_SECTION_PATTERNS = [
  /\b(?:raw\s+)?(?:session|prompt|transcript|conversation|chat\s*log)\s*[:：].*$/i,
  /\bprivate\s+(?:data|text|session|prompt)\s*[:：]?.*$/i,
];

const SECRET_VALUE_PATTERN =
  /\b(api[_ -]?key|token|secret|password|authorization|bearer)\b\s*[:=]\s*[^\s,;]+/gi;

/**
 * Redact marker summaries before forwarding them to conference events.
 * Marker parser payload fields still originate from comment text, so the bridge
 * treats raw prompt/session/transcript snippets and credential-looking values as
 * unsafe by default.
 */
function sanitizeSummaryText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const withoutBlocks = trimmed.replace(/```[\s\S]*?```/g, REDACTED_SUMMARY);
  const sanitizedLines = withoutBlocks
    .split(/\r?\n/)
    .map((line) => {
      let sanitized = line.trim();
      for (const pattern of INLINE_PRIVATE_SECTION_PATTERNS) {
        sanitized = sanitized.replace(pattern, REDACTED_SUMMARY);
      }
      sanitized = sanitized.replace(SECRET_VALUE_PATTERN, `$1: ${REDACTED_SUMMARY}`);
      return sanitized.trim();
    })
    .filter(Boolean);

  const sanitized = sanitizedLines
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/(?:\s*\[redacted\]){2,}/g, ` ${REDACTED_SUMMARY}`)
    .trim();

  if (!sanitized) {
    return REDACTED_SUMMARY;
  }

  return sanitized.length > MAX_SAFE_SUMMARY_LENGTH
    ? `${sanitized.slice(0, MAX_SAFE_SUMMARY_LENGTH - 1).trimEnd()}…`
    : sanitized;
}

function appendSafePart(parts: string[], value: unknown): void {
  const sanitized = sanitizeSummaryText(value);
  if (sanitized) {
    parts.push(sanitized);
  }
}

/**
 * Extract a safe summary from a worker status event payload.
 * Strips any raw prompt/session text, keeping only redacted structured info.
 */
function extractSafeSummary(event: WorkerStatusEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;

  switch (event.marker) {
    case "Start":
      return sanitizeSummaryText(payload.summary);
    case "Block":
      return sanitizeSummaryText(payload.reason);
    case "PR": {
      const parts: string[] = [];
      appendSafePart(parts, payload.verificationSummary);
      if (typeof payload.branch === "string" && payload.branch.trim()) {
        parts.push(`branch: ${payload.branch.trim()}`);
      }
      return parts.length > 0 ? parts.join("; ") : undefined;
    }
    case "Done":
      return sanitizeSummaryText(payload.completionSummary);
    default:
      return undefined;
  }
}

/**
 * Extract artifact URL from event (PR URL, issue URL, evidence URL, etc.).
 */
function extractArtifactUrl(event: WorkerStatusEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  for (const candidate of [payload.prUrl, payload.issueUrl, payload.doneUrl, payload.blockUrl]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function fingerprintStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function deriveFallbackConferenceEventId(
  event: WorkerStatusEvent,
  conferenceId: string,
  summary: string | undefined,
  artifactUrl: string | undefined,
): string {
  const fingerprint = fingerprintStable({
    marker: event.marker,
    taskId: event.taskId,
    artifactUrl: artifactUrl ?? "",
    summary: summary ?? "",
  });
  return `conf:${conferenceId}:${event.workerId}:fallback:${event.marker.toLowerCase()}:${fingerprint}`;
}

// ── Bridge result ──────────────────────────────────────────────

export interface BridgeSuccess {
  ok: true;
  event: ConferenceParticipantEvent;
}

export interface BridgeSkip {
  ok: true;
  skipped: true;
  reason: string;
}

export interface BridgeError {
  ok: false;
  error: string;
}

export type BridgeResult = BridgeSuccess | BridgeSkip | BridgeError;

// ── Conference deduplication store ─────────────────────────────

export class ConferenceDeduplicationStore {
  private seen = new Set<string>();
  private maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  add(eventId: string): void {
    if (this.seen.size >= this.maxSize && !this.seen.has(eventId)) {
      const iter = this.seen.values();
      const toRemove = Math.floor(this.maxSize * 0.1);
      for (let i = 0; i < toRemove; i++) {
        const entry = iter.next();
        if (entry.done) break;
        this.seen.delete(entry.value);
      }
    }
    this.seen.add(eventId);
  }

  clear(): void {
    this.seen.clear();
  }
}

// ── Main bridge function ───────────────────────────────────────

/**
 * Convert a worker status event into a conference participant event.
 * This is the core bridge from the Round 16/17 marker pipeline to
 * the Round 18 teleconference system.
 */
export function bridgeWorkerEventToConference(
  event: WorkerStatusEvent,
  conferenceId: string,
  dedupStore: ConferenceDeduplicationStore,
  source?: { repository?: string; issueNumber?: number; commentId?: number },
): BridgeResult {
  // 1. Map marker to conference action
  const marker = event.marker;
  const action = MARKER_TO_ACTION[marker];
  if (!action) {
    return {
      ok: false,
      error: `unknown marker type: ${marker}`,
    };
  }

  // 2. Extract safe summary (no raw text) and artifact before fallback ID derivation.
  const summary = extractSafeSummary(event);
  const artifactUrl = extractArtifactUrl(event);

  // 3. Derive conference event ID. Source comment IDs are preferred; the
  // fallback uses only stable, redacted marker-derived fields, never observedAt.
  const eventIdBase = typeof source?.commentId === "number"
    ? `conf:${conferenceId}:${event.workerId}:${source.commentId}:${marker.toLowerCase()}`
    : deriveFallbackConferenceEventId(event, conferenceId, summary, artifactUrl);

  // 4. Check deduplication
  if (dedupStore.has(eventIdBase)) {
    return {
      ok: true,
      skipped: true,
      reason: "duplicate conference event already processed",
    };
  }

  // 5. Build conference event
  const conferenceEvent: ConferenceParticipantEvent = {
    eventId: eventIdBase,
    conferenceId,
    participantId: event.workerId,
    action,
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

  // 6. Record for deduplication
  dedupStore.add(eventIdBase);

  return { ok: true, event: conferenceEvent };
}

/**
 * Full pipeline: ingest a GitHub comment and bridge to conference event.
 * Combines Round 17 ingestion with Round 18 conference bridging.
 */
export function ingestAndBridgeComment(
  payload: Record<string, unknown>,
  markerDedupStore: DeduplicationStore,
  conferenceDedupStore: ConferenceDeduplicationStore,
  options?: {
    loginToWorkerMap?: Record<string, string>;
    allowedActions?: string[];
  },
): BridgeResult | BridgeSkip {
  // 1. Ingest the comment (Round 17 pipeline)
  const ingestion = ingestGitHubComment(payload, markerDedupStore, options);

  // Handle ingestion errors
  if (!ingestion.ok) {
    return { ok: false, error: ingestion.error };
  }

  // Handle skips (no marker, wrong action, etc.)
  if ("skipped" in ingestion) {
    return {
      ok: true,
      skipped: true,
      reason: ingestion.reason,
    };
  }

  // 2. Extract source info
  const source = ingestion.source;
  const conferenceId = deriveConferenceId({
    repository: source.repository,
    issueNumber: source.issueNumber,
  });

  // 3. Bridge the parsed worker event produced by ingestion. Reusing the parsed
  // event avoids reparsing comment text and preserves the original parse metadata.
  return bridgeWorkerEventToConference(
    ingestion.workerEvent,
    conferenceId,
    conferenceDedupStore,
    {
      repository: source.repository,
      issueNumber: source.issueNumber,
      commentId: source.commentId,
    },
  );
}

/**
 * Batch bridge multiple GitHub comments into conference events.
 */
export function batchIngestAndBridge(
  payloads: Array<Record<string, unknown>>,
  markerDedupStore: DeduplicationStore,
  conferenceDedupStore: ConferenceDeduplicationStore,
  options?: {
    loginToWorkerMap?: Record<string, string>;
    allowedActions?: string[];
  },
): {
  results: Array<BridgeResult | BridgeSkip>;
  conferenced: number;
  skipped: number;
  errors: number;
} {
  const results: Array<BridgeResult | BridgeSkip> = [];
  let conferenced = 0;
  let skipped = 0;
  let errors = 0;

  for (const payload of payloads) {
    const result = ingestAndBridgeComment(payload, markerDedupStore, conferenceDedupStore, options);
    results.push(result);

    if (!result.ok) {
      errors++;
    } else if ("skipped" in result && result.skipped) {
      skipped++;
    } else {
      conferenced++;
    }
  }

  return { results, conferenced, skipped, errors };
}
