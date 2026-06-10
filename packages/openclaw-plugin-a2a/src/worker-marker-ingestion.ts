/**
 * GitHub worker marker ingestion path (Round 17, plugin-a2a#88).
 *
 * Consumes GitHub issue/PR comment webhook payloads and turns recognized
 * worker status markers (Start, Block, PR, Done) into broker-compatible
 * worker-status events.
 *
 * Built on top of the Round 16 `worker-status-marker.ts` normalizer.
 *
 * Key properties:
 * - Idempotent: duplicate webhook deliveries produce the same event ID.
 * - Safe degradation: malformed markers produce warnings, not errors.
 * - Zero OpenClaw internals imported.
 */

import {
  detectMarker,
  parseWorkerStatusMarker,
  toBrokerEvent,
  type WorkerStatusEvent,
  type WorkerStatusParseResult,
} from "./worker-status-marker.js";

// ── Source identifiers for idempotency ─────────────────────────

/**
 * Stable identifiers that uniquely identify a GitHub comment event
 * for idempotent processing.
 */
export interface GitHubCommentSource {
  /** GitHub delivery GUID (from X-GitHub-Delivery header). */
  deliveryId?: string;
  /** Repository full name (e.g., "jinwon-int/plugin-a2a"). */
  repository: string;
  /** Issue or PR number. */
  issueNumber: number;
  /** Comment ID (from the comment object). */
  commentId: number;
  /** Comment author login. */
  authorLogin: string;
}

/**
 * Extract source identifiers from a GitHub issue_comment or
 * pull_request_review_comment webhook payload.
 */
export function extractGitHubCommentSource(
  payload: Record<string, unknown>,
): GitHubCommentSource | null {
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (!repo || typeof repo.full_name !== "string") {
    return null;
  }

  // Issue number: from issue or pull_request
  const issue = payload.issue as Record<string, unknown> | undefined;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const subject = issue ?? pr;
  if (!subject || typeof subject.number !== "number") {
    return null;
  }

  // Comment ID
  const comment = payload.comment as Record<string, unknown> | undefined;
  if (!comment || typeof comment.id !== "number") {
    return null;
  }

  // Author login
  const user = (comment.user ?? payload.sender) as Record<string, unknown> | undefined;
  if (!user || typeof user.login !== "string") {
    return null;
  }

  return {
    repository: repo.full_name,
    issueNumber: subject.number,
    commentId: comment.id,
    authorLogin: user.login,
    deliveryId: typeof payload.deliveryId === "string" ? payload.deliveryId : undefined,
  };
}

/**
 * Derive a stable event ID from the source identifiers.
 * This ensures duplicate deliveries produce the same ID for idempotency.
 */
export function deriveEventId(source: GitHubCommentSource): string {
  // Use comment ID + marker position as the stable key
  // Format: gh:<repo>:<issue>#<commentId>
  return `gh:${source.repository}:${source.issueNumber}#${source.commentId}`;
}

/**
 * Build a GitHub issue comment URL from source identifiers.
 * Format: https://github.com/{repo}/issues/{issue}#issuecomment-{commentId}
 */
export function buildGitHubCommentUrl(source: GitHubCommentSource): string {
  return `https://github.com/${source.repository}/issues/${source.issueNumber}#issuecomment-${source.commentId}`;
}

// ── Ingestion result ───────────────────────────────────────────

export interface IngestionSuccess {
  ok: true;
  eventId: string;
  source: GitHubCommentSource;
  brokerEvent: ReturnType<typeof toBrokerEvent>;
  workerEvent: WorkerStatusEvent;
  parseStatus: "clean" | "partial" | "failed";
  warnings: string[];
}

export interface IngestionSkip {
  ok: true;
  skipped: true;
  reason: string;
  source: GitHubCommentSource;
}

export interface IngestionError {
  ok: false;
  error: string;
  source?: GitHubCommentSource;
}

export type IngestionResult = IngestionSuccess | IngestionSkip | IngestionError;

// ── Worker identity mapping ────────────────────────────────────

/**
 * Map a GitHub login to a worker ID. Returns the login as-is unless
 * a mapping is provided. This allows agents to use different GitHub
 * accounts than their node IDs.
 */
export function resolveWorkerId(
  authorLogin: string,
  loginToWorkerMap?: Record<string, string>,
): string {
  if (loginToWorkerMap && loginToWorkerMap[authorLogin]) {
    return loginToWorkerMap[authorLogin];
  }
  return authorLogin;
}

// ── Deduplication ──────────────────────────────────────────────

export interface DeduplicationStore {
  has(eventId: string): boolean;
  add(eventId: string): void;
}

/**
 * Simple in-memory deduplication store. Tracks event IDs that have
 * already been processed to prevent duplicate broker events from
 * repeated webhook deliveries.
 */
export class InMemoryDeduplicationStore implements DeduplicationStore {
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
      // Evict oldest entries (simple FIFO via iterator)
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

// ── Main ingestion function ────────────────────────────────────

/**
 * Ingest a GitHub issue/PR comment webhook payload and produce a
 * broker-compatible worker-status event if a marker is found.
 *
 * @param payload - The GitHub webhook payload (issue_comment or pull_request_review_comment).
 * @param dedupStore - Deduplication store to prevent duplicate processing.
 * @param options - Optional configuration for worker mapping.
 * @returns IngestionResult indicating success, skip, or error.
 */
export function ingestGitHubComment(
  payload: Record<string, unknown>,
  dedupStore: DeduplicationStore,
  options?: {
    loginToWorkerMap?: Record<string, string>;
    allowedActions?: string[];
  },
): IngestionResult {
  // 1. Extract source identifiers
  const source = extractGitHubCommentSource(payload);
  if (!source) {
    return {
      ok: false,
      error: "could not extract GitHub comment source identifiers from payload",
    };
  }

  // 2. Filter by action (only process created/edited comments by default)
  const action = typeof payload.action === "string" ? payload.action : "";
  const allowedActions = options?.allowedActions ?? ["created", "edited"];
  if (action && !allowedActions.includes(action)) {
    return {
      ok: true,
      skipped: true,
      reason: `action '${action}' is not in allowed list: ${allowedActions.join(", ")}`,
      source,
    };
  }

  // 3. Extract comment body
  const comment = payload.comment as Record<string, unknown> | undefined;
  if (!comment || typeof comment.body !== "string") {
    return {
      ok: false,
      error: "payload.comment.body is missing or not a string",
      source,
    };
  }

  const body = comment.body as string;

  // 4. Quick check: does the comment contain a marker at all?
  if (!detectMarker(body)) {
    return {
      ok: true,
      skipped: true,
      reason: "no worker status marker found in comment body",
      source,
    };
  }

  // 5. Check idempotency
  const eventId = deriveEventId(source);
  if (dedupStore.has(eventId)) {
    return {
      ok: true,
      skipped: true,
      reason: "duplicate event already processed",
      source,
    };
  }

  // 6. Resolve worker ID
  const workerId = resolveWorkerId(source.authorLogin, options?.loginToWorkerMap);
  const taskId = `${source.repository}#${source.issueNumber}`;

  // 7. Parse the marker
  const parsed: WorkerStatusParseResult = parseWorkerStatusMarker(body, workerId, taskId);

  if ("ok" in parsed && parsed.ok === false) {
    // Marker was detected but parsing failed
    return {
      ok: false,
      error: `marker parsing failed: ${parsed.error}`,
      source,
    };
  }

  const event = parsed as WorkerStatusEvent;

  // 8. Enrich read-only/libero evidence events with comment URL
  // For Done markers with evidence-only or no-change outcomes, populate
  // doneUrl from the comment URL itself (PR-less evidence lane).
  // For Block markers, populate blockUrl from the comment URL.
  if (event.marker === 'Done' &&
    'outcome' in event.payload) {
    const outcome = event.payload.outcome;
    if (outcome === 'done_evidence_only' || outcome === 'done_no_changes') {
      event.payload.doneUrl = buildGitHubCommentUrl(source);
    }
  }
  if (event.marker === 'Block') {
    event.payload.blockUrl = buildGitHubCommentUrl(source);
  }

  // 9. Convert to broker event
  const brokerEvent = toBrokerEvent(event);

  // 10. Record for deduplication
  dedupStore.add(eventId);

  // 11. Return success
  return {
    ok: true,
    eventId,
    source,
    brokerEvent,
    workerEvent: event,
    parseStatus: event.parseStatus,
    warnings: event.warnings,
  };
}

/**
 * Batch ingest multiple GitHub webhook payloads.
 * Returns individual results for each payload.
 */
export function batchIngestGitHubComments(
  payloads: Array<Record<string, unknown>>,
  dedupStore: DeduplicationStore,
  options?: {
    loginToWorkerMap?: Record<string, string>;
    allowedActions?: string[];
  },
): {
  results: IngestionResult[];
  ingested: number;
  skipped: number;
  errors: number;
} {
  const results: IngestionResult[] = [];
  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  for (const payload of payloads) {
    const result = ingestGitHubComment(payload, dedupStore, options);
    results.push(result);

    if (!result.ok) {
      errors++;
    } else if ("skipped" in result && result.skipped) {
      skipped++;
    } else {
      ingested++;
    }
  }

  return { results, ingested, skipped, errors };
}
