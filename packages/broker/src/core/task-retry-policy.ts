import type { TaskError, TaskRecord, TaskRetryPolicy } from "./types.js";

export const RETRY_HARD_DENY_CODES = new Set([
  "acceptance_failed",
  "acceptance_malformed",
  "github_completion_evidence_missing",
  "github_completion_receipt_invalid",
  "review_evidence_missing",
  "review_not_independent",
  "review_verdict_failed",
  "retry_policy_malformed",
  "source_projection_blocked",
  "spec_underspecified",
]);

const ALLOWED_RETRY_CLASSES = new Set(["environment", "worker_lost", "timeout"]);
const ENVIRONMENT_ERROR_CODES = new Set([
  "handler_exit_nonzero",
  "openclaw_analysis_failed",
  "openclaw_analysis_bridge_missing",
  "openclaw_analysis_no_final_json",
  "openclaw_analysis_spawn_failed",
  "payload_recovery_lossy",
  "docker_runner_exception",
  "docker_runner_failed",
  "openclaw_bridge_failed",
  "openclaw_bridge_no_final_json",
]);

export interface RetryPolicyValidationResult {
  ok: boolean;
  policy?: TaskRetryPolicy;
  missing: string[];
}

export interface RetryClassDecision {
  retryClass: string;
  retryable: boolean;
  hardDenied: boolean;
  reason: string;
  errorCode?: string;
}

export interface TaskRetryPlan {
  shouldRetry: boolean;
  retryClass?: string;
  nextAttempt?: number;
  nextRequeueCount?: number;
  retryTaskId?: string;
  retryNotBeforeAt?: string;
  reason: string;
}

export function validateTaskRetryPolicy(value: unknown): RetryPolicyValidationResult {
  if (value === undefined || value === null) return { ok: true, missing: [] };
  if (!isRecord(value)) return { ok: false, missing: ["retryPolicy"] };

  const missing: string[] = [];
  const maxRetries = typeof value.maxRetries === "number" ? value.maxRetries : undefined;
  if (maxRetries === undefined || !Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    missing.push("retryPolicy.maxRetries");
  }
  const retryOn = value.retryOn;
  if (
    !Array.isArray(retryOn) ||
    retryOn.length === 0 ||
    retryOn.some((item) => typeof item !== "string" || !ALLOWED_RETRY_CLASSES.has(item))
  ) {
    missing.push("retryPolicy.retryOn");
  }
  const backoffMs = typeof value.backoffMs === "number" ? value.backoffMs : undefined;
  if (value.backoffMs !== undefined && (backoffMs === undefined || !Number.isSafeInteger(backoffMs) || backoffMs < 0 || backoffMs > 86_400_000)) {
    missing.push("retryPolicy.backoffMs");
  }

  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    missing: [],
    policy: {
      maxRetries: maxRetries as number,
      retryOn: [...new Set(retryOn as string[])] as TaskRetryPolicy["retryOn"],
      backoffMs: backoffMs as number | undefined,
    },
  };
}

export function classifyTaskErrorForRetry(error: TaskError | undefined): RetryClassDecision {
  const errorCode = firstString(
    error?.code,
    nestedErrorCode(error?.details),
  );
  if (errorCode && RETRY_HARD_DENY_CODES.has(errorCode)) {
    return { retryClass: errorCode, retryable: false, hardDenied: true, reason: "hard_deny", errorCode };
  }

  if (errorCode === "worker_lost") {
    return { retryClass: "worker_lost", retryable: true, hardDenied: false, reason: "worker_lost", errorCode };
  }
  if (errorCode && /timeout/i.test(errorCode)) {
    return { retryClass: "timeout", retryable: true, hardDenied: false, reason: "timeout", errorCode };
  }
  const nestedCode = nestedErrorCode(error?.details);
  if (
    (errorCode && ENVIRONMENT_ERROR_CODES.has(errorCode)) ||
    (nestedCode && ENVIRONMENT_ERROR_CODES.has(nestedCode)) ||
    firstString(error?.details?.stage) === "handler"
  ) {
    return { retryClass: "environment", retryable: true, hardDenied: false, reason: "environment", errorCode };
  }

  return { retryClass: errorCode ?? "unknown", retryable: false, hardDenied: false, reason: "unclassified", errorCode };
}

export function planClassAwareTaskRetry(
  task: TaskRecord,
  error: TaskError | undefined,
  options: { maxRequeueAttempts: number; nowMs?: number; taskIdExists?: (id: string) => boolean },
): TaskRetryPlan {
  const validation = validateTaskRetryPolicy(task.payload?.retryPolicy);
  if (!validation.ok || !validation.policy || validation.policy.maxRetries === 0) {
    return { shouldRetry: false, reason: validation.ok ? "no_retry_policy" : "retry_policy_malformed" };
  }

  const decision = classifyTaskErrorForRetry(error);
  if (!decision.retryable || decision.hardDenied) {
    return { shouldRetry: false, retryClass: decision.retryClass, reason: decision.reason };
  }
  if (!validation.policy.retryOn.includes(decision.retryClass as TaskRetryPolicy["retryOn"][number])) {
    return { shouldRetry: false, retryClass: decision.retryClass, reason: "class_not_allowed" };
  }

  const currentAttempt = task.attempt ?? 0;
  if (currentAttempt >= validation.policy.maxRetries) {
    return { shouldRetry: false, retryClass: decision.retryClass, reason: "retry_policy_exhausted" };
  }
  const currentRequeueCount = task.requeueCount ?? 0;
  if (options.maxRequeueAttempts > 0 && currentRequeueCount >= options.maxRequeueAttempts) {
    return { shouldRetry: false, retryClass: decision.retryClass, reason: "shared_requeue_budget_exhausted" };
  }

  const nextAttempt = currentAttempt + 1;
  const rootTaskId = task.retryOfTaskId ?? task.id;
  const retryTaskId = nextRetryTaskId(rootTaskId, nextAttempt, options.taskIdExists);
  const backoffMs = validation.policy.backoffMs ?? 30_000;
  const retryNotBeforeAt = backoffMs > 0 ? new Date((options.nowMs ?? Date.now()) + backoffMs).toISOString() : undefined;
  return {
    shouldRetry: true,
    retryClass: decision.retryClass,
    nextAttempt,
    nextRequeueCount: currentRequeueCount + 1,
    retryTaskId,
    retryNotBeforeAt,
    reason: decision.reason,
  };
}

function nextRetryTaskId(rootTaskId: string, attempt: number, exists?: (id: string) => boolean): string {
  const base = `${rootTaskId}:retry-${attempt}`;
  if (!exists || !exists(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function nestedErrorCode(details: TaskError["details"]): string | undefined {
  if (!isRecord(details)) return undefined;
  for (const key of ["nestedError", "error", "cause", "runnerResult"]) {
    const nested = details[key];
    if (isRecord(nested)) {
      const code = firstString(nested.code, nested.errorCode);
      if (code) return code;
      const deeper = nestedErrorCode(nested as TaskError["details"]);
      if (deeper) return deeper;
    }
  }
  return firstString(details.code, details.errorCode);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
