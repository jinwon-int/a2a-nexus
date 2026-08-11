/**
 * Auth-rejection observability (#1764).
 *
 * The broker used to record `unauthorized` rejections nowhere: no log line, no
 * counter, no metric, no audit event. A worker whose credential had been
 * rotated away was therefore indistinguishable, from the broker side, from a
 * worker whose process had died — both just stopped heartbeating and decayed
 * `online -> stale -> task_worker_lost` on the same timeline. A T2 fleet
 * incident on 2026-08-08 spent 22 hours in that blind spot.
 *
 * This module is deliberately narrow:
 *
 * - It records only a BOUNDED classification. The route group is an existing
 *   closed enum and the reason comes from the allowlist below. Raw messages,
 *   headers, secrets, signatures, tokens and identities never enter a counter
 *   or a log line here, so turning rejections from silent into visible cannot
 *   turn them into a leak.
 * - It does not change the 401 wire contract. Reasons are derived from the
 *   message the throw site already produces; nothing new is serialized to the
 *   caller. (`BrokerError.details` is echoed into the response body by
 *   `http/error-mapping.ts`, so it must NOT be used to carry internal reasons.)
 * - Logging is rate limited per (route, reason) so an authentication-probing
 *   flood cannot turn the broker's own log into the outage.
 */

import type { RequestRouteGroup } from "./http/route-classification.js";

/**
 * Closed set of rejection reasons. `unspecified` is the safe default: a new or
 * reworded throw site degrades to a coarse-but-true classification rather than
 * leaking its message. `auth-rejection-metrics.test.ts` scans the source tree
 * and fails when a statically-worded `unauthorized` throw stops classifying, so
 * the mapping cannot silently rot.
 */
export const AUTH_REJECTION_REASONS = [
  "edge_secret_missing_or_invalid",
  "requester_id_missing",
  "requester_role_denied",
  "github_webhook_signature_missing",
  "github_webhook_signature_invalid",
  "live_approval_invalid",
  "live_approval_identity_denied",
  "peer_credential_denied",
  "a2a_signature_failed",
  "unspecified",
] as const;

export type AuthRejectionReason = (typeof AUTH_REJECTION_REASONS)[number];

/**
 * Signature-family failures already carry a machine-readable code as a
 * `"<code>: <message>"` prefix (the ten `A2AHttpSignatureFailureCode` values
 * plus the digest/required/replay gates). They are collapsed into one reason
 * with the specific code kept as a bounded sub-code, so a key rotation and a
 * clock skew stay distinguishable without widening the enum every time the
 * verifier grows a case.
 */
const SIGNATURE_CODE_PREFIX = "a2a_signature";
const SIGNATURE_SUBCODE_PATTERN = /^a2a_signature[a-z0-9_]{0,48}$/;

/**
 * Exact/substring mapping for the throw sites that predate the code-prefix
 * convention. Matching is on developer-authored static text only — never on
 * interpolated values.
 */
const STATIC_MESSAGE_REASONS: ReadonlyArray<readonly [string, AuthRejectionReason]> = [
  ["x-a2a-edge-secret is required", "edge_secret_missing_or_invalid"],
  ["x-hub-signature-256 is required", "github_webhook_signature_missing"],
  ["x-hub-signature-256 verification failed", "github_webhook_signature_invalid"],
  ["x-a2a-requester-id is required", "requester_id_missing"],
  ["requester role must be one of", "requester_role_denied"],
  ["hub/operator role", "requester_role_denied"],
  ["require the proposal source, target, or an operator requester", "requester_role_denied"],
  ["live approval", "live_approval_invalid"],
  ["invalid live approval", "live_approval_invalid"],
  ["live task submission requires an authenticated operator or hub", "live_approval_identity_denied"],
  ["live task requester identity mismatch", "live_approval_identity_denied"],
  // Cross-broker peer handoff credentials (core/request-security.ts). All
  // three throw sites collapse into one reason on purpose: the wire responses
  // are deliberately indistinguishable, and the metrics must not become the
  // oracle that leaks which part of the credential failed.
  ["peer credentials are not accepted by this broker", "peer_credential_denied"],
  ["x-a2a-peer-broker-id and x-a2a-peer-secret must be presented together", "peer_credential_denied"],
  ["peer credential rejected", "peer_credential_denied"],
];

export interface AuthRejectionClassification {
  reason: AuthRejectionReason;
  /** Bounded signature sub-code, present only for the signature family. */
  subCode?: string;
}

export function classifyAuthRejection(message: string): AuthRejectionClassification {
  const separator = message.indexOf(": ");
  if (separator > 0 && separator <= 60) {
    const token = message.slice(0, separator);
    if (SIGNATURE_SUBCODE_PATTERN.test(token)) {
      return { reason: "a2a_signature_failed", subCode: token };
    }
  }
  if (message.startsWith(SIGNATURE_CODE_PREFIX)) {
    return { reason: "a2a_signature_failed" };
  }
  // Longest match first so "live task requester identity mismatch" is not
  // swallowed by the coarser "live approval" entry.
  let best: AuthRejectionReason | undefined;
  let bestLength = -1;
  for (const [needle, reason] of STATIC_MESSAGE_REASONS) {
    if (needle.length > bestLength && message.includes(needle)) {
      best = reason;
      bestLength = needle.length;
    }
  }
  return { reason: best ?? "unspecified" };
}

/** Distinct (route, reason) keys tracked before new keys spill into `overflow`. */
export const AUTH_REJECTION_MAX_KEYS = 200;
/** Minimum gap between log lines for the same (route, reason). */
export const AUTH_REJECTION_LOG_INTERVAL_MS = 60_000;

interface AuthRejectionEntry {
  route: RequestRouteGroup;
  reason: AuthRejectionReason;
  count: number;
  subCodes: Map<string, number>;
  firstAtMs: number;
  lastAtMs: number;
  lastLoggedAtMs: number | undefined;
  suppressedSinceLastLog: number;
}

const entries = new Map<string, AuthRejectionEntry>();
let overflowCount = 0;
let totalCount = 0;
let sinceMs: number | undefined;

export interface AuthRejectionRecordInput {
  route: RequestRouteGroup;
  method: string | undefined;
  message: string;
  nowMs?: number;
}

export interface AuthRejectionRecordResult {
  reason: AuthRejectionReason;
  subCode?: string;
  /** True when the caller should emit a log line for this rejection. */
  shouldLog: boolean;
  /** Rejections of the same (route, reason) swallowed since the last log line. */
  suppressedSinceLastLog: number;
  /** Running total for this (route, reason). */
  count: number;
}

export function recordAuthRejection(input: AuthRejectionRecordInput): AuthRejectionRecordResult {
  const nowMs = input.nowMs ?? Date.now();
  const { reason, subCode } = classifyAuthRejection(input.message);
  totalCount += 1;
  sinceMs ??= nowMs;

  const key = `${input.route}|${reason}`;
  let entry = entries.get(key);
  if (!entry) {
    if (entries.size >= AUTH_REJECTION_MAX_KEYS) {
      // Bounded by construction: both components of the key are closed sets, so
      // this is a backstop against future enum growth, not an expected path.
      overflowCount += 1;
      return { reason, ...(subCode ? { subCode } : {}), shouldLog: false, suppressedSinceLastLog: 0, count: 0 };
    }
    entry = {
      route: input.route,
      reason,
      count: 0,
      subCodes: new Map(),
      firstAtMs: nowMs,
      lastAtMs: nowMs,
      lastLoggedAtMs: undefined,
      suppressedSinceLastLog: 0,
    };
    entries.set(key, entry);
  }
  entry.count += 1;
  entry.lastAtMs = nowMs;
  if (subCode) {
    entry.subCodes.set(subCode, (entry.subCodes.get(subCode) ?? 0) + 1);
  }

  const dueForLog =
    entry.lastLoggedAtMs === undefined || nowMs - entry.lastLoggedAtMs >= AUTH_REJECTION_LOG_INTERVAL_MS;
  if (!dueForLog) {
    entry.suppressedSinceLastLog += 1;
    return {
      reason,
      ...(subCode ? { subCode } : {}),
      shouldLog: false,
      suppressedSinceLastLog: entry.suppressedSinceLastLog,
      count: entry.count,
    };
  }
  const suppressed = entry.suppressedSinceLastLog;
  entry.suppressedSinceLastLog = 0;
  entry.lastLoggedAtMs = nowMs;
  return {
    reason,
    ...(subCode ? { subCode } : {}),
    shouldLog: true,
    suppressedSinceLastLog: suppressed,
    count: entry.count,
  };
}

export interface AuthRejectionSnapshotEntry {
  route: RequestRouteGroup;
  reason: AuthRejectionReason;
  count: number;
  firstAt: string;
  lastAt: string;
  subCodes?: Record<string, number>;
}

export interface AuthRejectionSnapshot {
  total: number;
  since?: string;
  trackedKeys: number;
  droppedKeys: number;
  byReason: Record<string, number>;
  top: AuthRejectionSnapshotEntry[];
}

/** Number of (route, reason) entries surfaced on the read path. */
export const AUTH_REJECTION_SNAPSHOT_TOP_N = 10;

export function authRejectionSnapshot(): AuthRejectionSnapshot {
  const byReason: Record<string, number> = {};
  for (const entry of entries.values()) {
    byReason[entry.reason] = (byReason[entry.reason] ?? 0) + entry.count;
  }
  const top = [...entries.values()]
    .sort((a, b) => (b.count - a.count) || (b.lastAtMs - a.lastAtMs))
    .slice(0, AUTH_REJECTION_SNAPSHOT_TOP_N)
    .map((entry): AuthRejectionSnapshotEntry => ({
      route: entry.route,
      reason: entry.reason,
      count: entry.count,
      firstAt: new Date(entry.firstAtMs).toISOString(),
      lastAt: new Date(entry.lastAtMs).toISOString(),
      ...(entry.subCodes.size > 0 ? { subCodes: Object.fromEntries(entry.subCodes) } : {}),
    }));
  return {
    total: totalCount,
    ...(sinceMs !== undefined ? { since: new Date(sinceMs).toISOString() } : {}),
    trackedKeys: entries.size,
    droppedKeys: overflowCount,
    byReason,
    top,
  };
}

/** Test-only: module-global counters would otherwise make suites order-dependent. */
export function resetAuthRejectionMetrics(): void {
  entries.clear();
  overflowCount = 0;
  totalCount = 0;
  sinceMs = undefined;
}
