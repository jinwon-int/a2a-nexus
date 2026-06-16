// Default-off advisory sidecar recommendation contract (#785).
//
// This module is deliberately pure and no-live: it does not start a sidecar
// process, send providers, mutate broker state, or change dispatch/routing. The
// returned recommendation is advisory only. Callers must still enforce
// finalizer decisions, deterministic routing policy, worker capability checks,
// model allowlists, approval gates, and secret redaction before taking any
// action.

export type AdvisorySidecarStatus = "enabled" | "disabled" | "timeout" | "unavailable";
export type AdvisorySidecarFallbackReason = "disabled" | "timeout" | "unavailable" | "malformed";

export interface AdvisorySidecarRecommendation {
  schemaVersion: 1;
  taskType: string;
  recommendedWorkerIds: readonly string[];
  recommendedModel: string | null;
  confidence: number;
  reason: string;
  needsHuman: boolean;
  wikiQueries: readonly string[];
  advisoryOnly: true;
}

export interface AdvisorySidecarResolution {
  status: "recommended" | "fallback";
  recommendation: AdvisorySidecarRecommendation;
  fallbackReason?: AdvisorySidecarFallbackReason;
}

export const ADVISORY_SIDECAR_SECRET_FIELD_PATTERN =
  /(^|[_-])(api[-_]?key|access[-_]?token|auth[-_]?token|bearer|credential|credentials|password|passwd|secret|session[-_]?id|refresh[-_]?token|private[-_]?key)([_-]|$)/i;

const MAX_TASK_TYPE_LENGTH = 80;
const MAX_REASON_LENGTH = 1_000;
const MAX_WORKER_ID_LENGTH = 80;
const MAX_WORKER_IDS = 8;
const MAX_MODEL_LENGTH = 160;
const MAX_WIKI_QUERY_LENGTH = 240;
const MAX_WIKI_QUERIES = 8;

const FALLBACK_REASONS: Record<AdvisorySidecarFallbackReason, string> = {
  disabled: "Advisory sidecar is disabled; deterministic broker/finalizer policy remains authoritative.",
  timeout: "Advisory sidecar timed out; deterministic broker/finalizer policy remains authoritative.",
  unavailable: "Advisory sidecar is unavailable; deterministic broker/finalizer policy remains authoritative.",
  malformed: "Advisory sidecar returned malformed or unsafe output; deterministic broker/finalizer policy remains authoritative.",
};

export const DEFAULT_DISABLED_ADVISORY_SIDECAR_RECOMMENDATION: AdvisorySidecarRecommendation =
  Object.freeze({
    schemaVersion: 1,
    taskType: "unknown",
    recommendedWorkerIds: Object.freeze([]),
    recommendedModel: null,
    confidence: 0,
    reason: FALLBACK_REASONS.disabled,
    needsHuman: true,
    wikiQueries: Object.freeze([]),
    advisoryOnly: true,
  });

/**
 * Validate untrusted advisory sidecar output. Returns null for malformed output
 * or secret-like fields. Unsupported model identifiers are preserved: this
 * contract is not the model allowlist and cannot authorize dispatch.
 */
export function validateAdvisorySidecarRecommendation(input: unknown): AdvisorySidecarRecommendation | null {
  if (!isPlainRecord(input)) return null;
  if (containsSecretLikeField(input)) return null;

  const schemaVersion = input.schemaVersion ?? 1;
  if (schemaVersion !== 1) return null;

  const taskType = boundedNonEmptyString(input.taskType, MAX_TASK_TYPE_LENGTH);
  const recommendedWorkerIds = boundedStringArray(input.recommendedWorkerIds, MAX_WORKER_IDS, MAX_WORKER_ID_LENGTH, {
    allowEmpty: true,
  });
  const recommendedModel = input.recommendedModel === null || input.recommendedModel === undefined
    ? null
    : boundedNonEmptyString(input.recommendedModel, MAX_MODEL_LENGTH);
  const confidence = normalizedConfidence(input.confidence);
  const reason = boundedNonEmptyString(input.reason, MAX_REASON_LENGTH);
  const needsHuman = typeof input.needsHuman === "boolean" ? input.needsHuman : undefined;
  const wikiQueries = boundedStringArray(input.wikiQueries, MAX_WIKI_QUERIES, MAX_WIKI_QUERY_LENGTH, {
    allowEmpty: true,
  });
  const advisoryOnly = input.advisoryOnly === undefined ? true : input.advisoryOnly;

  if (
    taskType === undefined ||
    recommendedWorkerIds === undefined ||
    recommendedModel === undefined ||
    confidence === undefined ||
    reason === undefined ||
    needsHuman === undefined ||
    wikiQueries === undefined ||
    advisoryOnly !== true
  ) {
    return null;
  }

  return Object.freeze({
    schemaVersion: 1,
    taskType,
    recommendedWorkerIds: Object.freeze(recommendedWorkerIds),
    recommendedModel,
    confidence,
    reason,
    needsHuman,
    wikiQueries: Object.freeze(wikiQueries),
    advisoryOnly: true,
  });
}

export function isAdvisorySidecarRecommendation(input: unknown): input is AdvisorySidecarRecommendation {
  return validateAdvisorySidecarRecommendation(input) !== null;
}

/**
 * Resolve sidecar output into either a validated recommendation or deterministic
 * fail-closed fallback. Non-enabled statuses never inspect raw output.
 */
export function resolveAdvisorySidecarRecommendation(
  status: AdvisorySidecarStatus,
  rawOutput?: unknown,
): AdvisorySidecarResolution {
  if (status !== "enabled") {
    return {
      status: "fallback",
      fallbackReason: status,
      recommendation: buildAdvisorySidecarFallback(status),
    };
  }

  const recommendation = validateAdvisorySidecarRecommendation(rawOutput);
  if (!recommendation) {
    return {
      status: "fallback",
      fallbackReason: "malformed",
      recommendation: buildAdvisorySidecarFallback("malformed"),
    };
  }

  return { status: "recommended", recommendation };
}

export function buildAdvisorySidecarFallback(reason: AdvisorySidecarFallbackReason): AdvisorySidecarRecommendation {
  if (reason === "disabled") return DEFAULT_DISABLED_ADVISORY_SIDECAR_RECOMMENDATION;
  return Object.freeze({
    schemaVersion: 1,
    taskType: "unknown",
    recommendedWorkerIds: Object.freeze([]),
    recommendedModel: null,
    confidence: 0,
    reason: FALLBACK_REASONS[reason],
    needsHuman: true,
    wikiQueries: Object.freeze([]),
    advisoryOnly: true,
  });
}

function normalizedConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
  return Number(value.toFixed(4));
}

function boundedNonEmptyString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  return trimmed;
}

function boundedStringArray(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
  options: { allowEmpty: boolean },
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!options.allowEmpty && value.length === 0) return undefined;
  if (value.length > maxItems) return undefined;
  const output: string[] = [];
  for (const item of value) {
    const normalized = boundedNonEmptyString(item, maxItemLength);
    if (normalized === undefined) return undefined;
    output.push(normalized);
  }
  return output;
}

function containsSecretLikeField(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsSecretLikeField(item, depth + 1));
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (ADVISORY_SIDECAR_SECRET_FIELD_PATTERN.test(key)) return true;
    if (containsSecretLikeField(nested, depth + 1)) return true;
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
