/**
 * Recovery action adapter (Round 14).
 *
 * Bridges broker recovery decisions into plugin-side actions with strict
 * payload normalization. Handles retry, cancel, requeue, continue, and
 * inspect recovery actions.
 *
 * Safety: all actions are default-safe. No live state mutation unless the
 * operator path explicitly requests it (dryRun defaults to true).
 *
 * Compatibility: accepts Round 13 NormalizedA2APayload shapes alongside
 * canonical broker recovery payloads.
 */

import { isPlainObject } from "./value-guards.js";

// ── Recovery action types ──────────────────────────────────────

export const RecoveryActionKinds = [
  "retry",
  "cancel",
  "requeue",
  "continue",
  "inspect",
] as const;

export type RecoveryActionKind = (typeof RecoveryActionKinds)[number];

// ── Broker reference fields ────────────────────────────────────

export interface BrokerReference {
  /** GitHub issue URL or number */
  githubIssue?: string;
  /** Pull request URL */
  prUrl?: string;
  /** Source identifier (e.g., webhook event source) */
  sourceId?: string;
  /** Flow identifier for multi-step tasks */
  flowId?: string;
  /** Broker task ID */
  taskId?: string;
  /** Runtime run ID */
  runId?: string;
  /** Child session key for delegated sub-tasks */
  childSessionKey?: string;
  /** Session key of the requester */
  sessionKey?: string;
}

// ── Recovery payload ───────────────────────────────────────────

export interface RecoveryPayload {
  action: RecoveryActionKind;
  reference: BrokerReference;
  /** Reason for the recovery action */
  reason?: string;
  /** Operator display name */
  operator?: string;
  /** Explicit dry-run flag. Defaults to true for safety. */
  dryRun?: boolean;
  /** Additional context from broker projection */
  context?: Record<string, unknown>;
  /** Original payload shape (Round 13 compat) */
  originalPayload?: Record<string, unknown>;
}

// ── Normalized recovery action ─────────────────────────────────

export interface NormalizedRecoveryAction {
  ok: true;
  action: RecoveryActionKind;
  reference: BrokerReference;
  reason: string;
  operator: string;
  dryRun: boolean;
  context: Record<string, unknown>;
  metadata: {
    normalizedAt: number;
    source: "broker-recovery" | "round13-compat" | "manual";
    originalShape: Record<string, unknown>;
  };
}

// ── Error codes ────────────────────────────────────────────────

export const RecoveryAdapterErrorCodes = {
  INVALID_RECOVERY_SHAPE: "INVALID_RECOVERY_SHAPE",
  INVALID_ACTION_KIND: "INVALID_ACTION_KIND",
  MISSING_REFERENCE: "MISS_REFERENCE",
  AMBIGUOUS_REFERENCE: "AMBIGUOUS_REFERENCE",
  INVALID_REFERENCE_FIELD: "INVALID_REFERENCE_FIELD",
  MUTATION_NOT_AUTHORIZED: "MUTATION_NOT_AUTHORIZED",
  ROUND13_COMPAT_FAILURE: "ROUND13_COMPAT_FAILURE",
} as const;

export type RecoveryAdapterErrorCode =
  (typeof RecoveryAdapterErrorCodes)[keyof typeof RecoveryAdapterErrorCodes];

export interface RecoveryAdapterError {
  ok: false;
  error: {
    code: RecoveryAdapterErrorCode;
    message: string;
    field?: string;
  };
}

export type RecoveryAdapterResult = NormalizedRecoveryAction | RecoveryAdapterError;

// ── Helpers ────────────────────────────────────────────────────


function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isPlainObject(value) ? value : undefined;
}

function fail(
  code: RecoveryAdapterErrorCode,
  message: string,
  field?: string,
): RecoveryAdapterError {
  return { ok: false, error: { code, message, ...(field ? { field } : {}) } };
}

const VALID_ACTIONS: ReadonlySet<string> = new Set(RecoveryActionKinds);

const ALLOWED_REFERENCE_KEYS = new Set([
  "githubIssue", "prUrl", "sourceId", "flowId",
  "taskId", "runId", "childSessionKey", "sessionKey",
]);

const ALLOWED_PAYLOAD_KEYS = new Set([
  "action", "reference", "reason", "operator",
  "dryRun", "context", "originalPayload",
]);

// ── Reference validation ───────────────────────────────────────

function normalizeReference(input: unknown): { ok: true; data: BrokerReference } | RecoveryAdapterError {
  if (!isPlainObject(input)) {
    return fail(RecoveryAdapterErrorCodes.MISSING_REFERENCE, "reference must be an object", "reference");
  }

  // Check for unknown reference keys
  for (const key of Object.keys(input)) {
    if (!ALLOWED_REFERENCE_KEYS.has(key)) {
      // Unknown keys in reference are ignored, not errors — forward compat
    }
  }

  const ref: BrokerReference = {};
  const githubIssue = readString(input, "githubIssue");
  const prUrl = readString(input, "prUrl");
  const sourceId = readString(input, "sourceId");
  const flowId = readString(input, "flowId");
  const taskId = readString(input, "taskId");
  const runId = readString(input, "runId");
  const childSessionKey = readString(input, "childSessionKey");
  const sessionKey = readString(input, "sessionKey");

  if (githubIssue !== undefined) {
    // Accept URLs or plain numbers
    if (!/^(?:https?:\/\/github\.com\/|[0-9]+$)/.test(githubIssue) && !/^[A-Za-z0-9._\-]+\/[A-Za-z0-9._\-]+#[0-9]+$/.test(githubIssue)) {
      return fail(
        RecoveryAdapterErrorCodes.INVALID_REFERENCE_FIELD,
        `githubIssue must be a URL, owner/repo#number, or plain number (got "${githubIssue}")`,
        "reference.githubIssue",
      );
    }
    ref.githubIssue = githubIssue;
  }

  if (prUrl !== undefined) {
    if (!prUrl.startsWith("https://") && !prUrl.startsWith("http://")) {
      return fail(
        RecoveryAdapterErrorCodes.INVALID_REFERENCE_FIELD,
        `prUrl must be an HTTP(S) URL (got "${prUrl}")`,
        "reference.prUrl",
      );
    }
    ref.prUrl = prUrl;
  }

  if (sourceId !== undefined) ref.sourceId = sourceId;
  if (flowId !== undefined) ref.flowId = flowId;
  if (taskId !== undefined) ref.taskId = taskId;
  if (runId !== undefined) ref.runId = runId;
  if (childSessionKey !== undefined) ref.childSessionKey = childSessionKey;
  if (sessionKey !== undefined) ref.sessionKey = sessionKey;

  // At least one identifying field must be present
  const identifierCount = [
    ref.taskId, ref.runId, ref.sourceId, ref.flowId,
    ref.githubIssue, ref.prUrl, ref.childSessionKey, ref.sessionKey,
  ].filter(Boolean).length;

  if (identifierCount === 0) {
    return fail(
      RecoveryAdapterErrorCodes.MISSING_REFERENCE,
      "reference must contain at least one identifying field (taskId, runId, sourceId, flowId, githubIssue, prUrl, childSessionKey, sessionKey)",
      "reference",
    );
  }

  return { ok: true as const, data: ref };
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Detect if an input looks like a Round 13 NormalizedA2APayload that
 * should be adapted into a recovery action.
 */
export function isRound13CompatPayload(input: unknown): boolean {
  if (!isPlainObject(input)) return false;
  return input.ok === true && typeof input.instructions === "string" && isPlainObject(input.metadata);
}

/**
 * Normalize a recovery action payload into a stable internal shape.
 * Returns a discriminated result with actionable errors for invalid input.
 *
 * Safety: dryRun defaults to true. Callers must explicitly set dryRun=false
 * to perform live mutations.
 */
export function normalizeRecoveryAction(input: unknown): RecoveryAdapterResult {
  if (!isPlainObject(input)) {
    return fail(RecoveryAdapterErrorCodes.INVALID_RECOVERY_SHAPE, "recovery payload must be a non-null object");
  }

  // Detect Round 13 compat — treat as "inspect" by default
  if (isRound13CompatPayload(input)) {
    const compatResult = normalizeRound13AsRecovery(input);
    if (!compatResult.ok) return compatResult;
    return compatResult;
  }

  // Validate action
  const rawAction = readString(input, "action");
  if (!rawAction || !VALID_ACTIONS.has(rawAction)) {
    const got = rawAction ?? typeof (input as Record<string, unknown>).action;
    return fail(
      RecoveryAdapterErrorCodes.INVALID_ACTION_KIND,
      `action must be one of: ${RecoveryActionKinds.join(", ")} (got ${got})`,
      "action",
    );
  }
  const action = rawAction as RecoveryActionKind;

  // Validate reference
  const rawReference = input.reference;
  const refResult = normalizeReference(rawReference);
  if (!refResult.ok) return refResult;
  const reference = refResult.data;

  const reason = readString(input, "reason") ?? "";
  const operator = readString(input, "operator") ?? "";
  const dryRun = input.dryRun !== false; // default true
  const context = readRecord(input, "context") ?? {};
  const originalPayload = readRecord(input, "originalPayload");

  // Safety gate: non-dryRun mutations require operator
  if (!dryRun && !operator) {
    return fail(
      RecoveryAdapterErrorCodes.MUTATION_NOT_AUTHORIZED,
      "non-dryRun recovery action requires an operator field",
      "operator",
    );
  }

  return {
    ok: true as const,
    action,
    reference,
    reason,
    operator,
    dryRun,
    context,
    metadata: {
      normalizedAt: Date.now(),
      source: "broker-recovery" as const,
      originalShape: {
        action,
        reference,
        ...(reason ? { reason } : {}),
        ...(operator ? { operator } : {}),
        dryRun,
        ...(originalPayload ? { originalPayload } : {}),
      },
    },
  };
}

/**
 * Adapt a Round 13 NormalizedA2APayload into a recovery action (inspect mode).
 */
function normalizeRound13AsRecovery(input: Record<string, unknown>): RecoveryAdapterResult {
  const metadata = readRecord(input, "metadata") ?? {};
  const target = input.target as Record<string, unknown> | undefined;
  const requester = input.requester as Record<string, unknown> | undefined;

  const reference: BrokerReference = {
    sessionKey: (target as Record<string, unknown>)?.sessionKey as string | undefined ?? "",
  };

  if (isPlainObject(target)) {
    const sk = readString(target, "sessionKey");
    if (sk) reference.sessionKey = sk;
  }

  return {
    ok: true as const,
    action: "inspect" as const,
    reference,
    reason: (input.instructions as string) ?? "",
    operator: isPlainObject(requester) ? (readString(requester, "sessionKey") ?? "") : "",
    dryRun: true,
    context: { round13Payload: input },
    metadata: {
      normalizedAt: Date.now(),
      source: "round13-compat" as const,
      originalShape: input,
    },
  };
}

/**
 * Validate a recovery payload without performing normalization.
 * Returns compatibility status and warnings.
 */
export function validateRecoveryPayload(input: unknown): {
  compatible: boolean;
  isRound13Compat: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (!isPlainObject(input)) {
    return { compatible: false, isRound13Compat: false, warnings: ["payload is not a plain object"] };
  }

  const isR13 = isRound13CompatPayload(input);
  if (isR13) {
    return { compatible: true, isRound13Compat: true, warnings: [] };
  }

  const rawAction = readString(input, "action");
  if (!rawAction) {
    warnings.push("missing action field");
  } else if (!VALID_ACTIONS.has(rawAction)) {
    warnings.push(`unknown action kind: ${rawAction}`);
  }

  const rawRef = readRecord(input, "reference");
  if (!rawRef) {
    warnings.push("missing reference object");
  } else {
    const identifierCount = [
      "githubIssue", "prUrl", "sourceId", "flowId",
      "taskId", "runId", "childSessionKey", "sessionKey",
    ].filter((key) => readString(rawRef, key) !== undefined).length;

    if (identifierCount === 0) {
      warnings.push("reference has no identifying fields");
    }
  }

  if (input.dryRun === false && !readString(input, "operator")) {
    warnings.push("non-dryRun action without operator field");
  }

  // Check for unknown top-level keys
  for (const key of Object.keys(input)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) {
      warnings.push(`unknown field in recovery payload: ${key}`);
    }
  }

  const actionValid = rawAction && VALID_ACTIONS.has(rawAction);
  const hasRefIdent = rawRef && ["githubIssue", "prUrl", "sourceId", "flowId", "taskId", "runId", "childSessionKey", "sessionKey"].some((k) => readString(rawRef, k) !== undefined);
  const compatible = !!(actionValid && hasRefIdent);

  return {
    compatible,
    isRound13Compat: false,
    warnings,
  };
}
