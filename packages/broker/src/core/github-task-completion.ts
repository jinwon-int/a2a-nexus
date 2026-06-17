import type { TaskError, TaskRecord, TaskResult } from "./types.js";

const GITHUB_TASK_MODES = new Set(["github-propose-patch", "github-issue-instruction"]);
const READ_ONLY_ANALYSIS_MODES = new Set(["analysis-only", "read-only-analysis", "analyze-only"]);
const GITHUB_READ_ONLY_VALIDATION_MODES = new Set([
  "github-verify",
  "github-read-only-validation",
  "read-only-validation",
  "github-libero-validation",
  "libero-validation",
  "family-wiki-readonly-audit",
]);
const REVIEW_VERDICTS = new Set(["approve", "request_changes", "comment"]);
const RECEIPT_STATUSES = new Set([
  "accepted",
  "started",
  "produced",
  "sent",
  "provider_sent",
  "provider_accepted",
  "current_session_visible",
  "operator_visible",
  "timed_out",
  "stale",
  "failed",
]);
const RECEIPT_ACK_EVIDENCE = new Set([
  "current_session_visible",
  "operator_visible",
  "operator_confirmed",
]);

export function validateGithubTaskCompletionEvidence(task: TaskRecord, result?: TaskResult): TaskError | null {
  if (!requiresGithubCompletionEvidence(task)) {
    return null;
  }

  if (isGithubReadOnlyValidationTask(task)) {
    if (!hasGithubNoPatchCompletionEvidence(result) && !hasGithubReviewVerdictEvidence(result) && !hasGithubStructuredBlockEvidence(result)) {
      return {
        code: "github_completion_evidence_missing",
        message:
          "github-origin read-only validation/libero tasks must return Done-comment or Block-comment evidence, a review verdict (approve/request_changes/comment) with a review body reference, or structured preflight Block evidence; PR-only evidence is reserved for propose_patch tasks",
        details: {
          taskId: task.id,
          taskOrigin: task.taskOrigin,
          mode: typeof task.payload?.mode === "string" ? task.payload.mode : undefined,
          requiredEvidence: [
            "result.output.github.doneCommentUrl",
            "result.output.github.blockCommentUrl",
            "result.output.doneCommentUrl",
            "result.output.blockCommentUrl",
            "result.output.reviewVerdict (+ result.output.reviewBodyUrl/reviewBodyRef)",
            "result.output.review.verdict (+ result.output.review.bodyUrl/bodyRef)",
            "result.output.analysisStatus=blocked + analysisKind=github_readonly_executor_preflight + blockReason",
          ],
          observedEvidence: summarizeObservedCompletionEvidence(result),
        },
      };
    }

    // Read-only completion evidence is satisfied (Done/Block marker or review
    // verdict). These lanes never produce a patch, so the propose_patch PR-style
    // evidence requirement below does not apply; only receipt sanity remains.
    return validateCompletionReceipt(result);
  }

  if (!hasGithubCompletionEvidence(result)) {
    return {
      code: "github_completion_evidence_missing",
      message:
        "github-origin propose_patch tasks must return PR, Done-comment, or Block-comment evidence before they can succeed",
      details: {
        taskId: task.id,
        taskOrigin: task.taskOrigin,
        mode: typeof task.payload?.mode === "string" ? task.payload.mode : undefined,
        requiredEvidence: [
          "result.output.github.prUrl",
          "result.output.github.doneCommentUrl",
          "result.output.github.blockCommentUrl",
          "result.output.prUrl",
          "result.output.doneCommentUrl",
          "result.output.blockCommentUrl",
        ],
        observedEvidence: summarizeObservedCompletionEvidence(result),
      },
    };
  }

  const receiptError = validateCompletionReceipt(result);
  if (receiptError) {
    return receiptError;
  }

  return null;
}

export function requiresGithubCompletionEvidence(task: TaskRecord): boolean {
  if (isGithubReadOnlyValidationTask(task)) {
    return true;
  }

  // Analysis-only / read-only tasks that are not GitHub validation lanes are
  // exempt from PR evidence requirements. They carry findings/summary/risks
  // without producing a patch or pull request.
  if (task.intent === "analyze" && isReadOnlyAnalysisMode(task.payload?.mode)) {
    return false;
  }

  const mode = typeof task.payload?.mode === "string" ? task.payload.mode : undefined;
  return task.intent === "propose_patch" && (task.taskOrigin === "github" || isGithubTaskMode(mode));
}

function isGithubTaskMode(mode: string | undefined): boolean {
  return mode !== undefined && GITHUB_TASK_MODES.has(mode);
}

function isGithubReadOnlyValidationTask(task: TaskRecord): boolean {
  if (task.taskOrigin !== "github") {
    return false;
  }

  const mode = typeof task.payload?.mode === "string" ? task.payload.mode : undefined;
  if (!mode) {
    return false;
  }

  if (task.intent === "verify" && GITHUB_READ_ONLY_VALIDATION_MODES.has(mode)) {
    return true;
  }

  if (task.intent === "analyze" && GITHUB_READ_ONLY_VALIDATION_MODES.has(mode)) {
    return true;
  }

  return task.intent === "validate_change" && GITHUB_READ_ONLY_VALIDATION_MODES.has(mode);
}

function isReadOnlyAnalysisMode(mode: unknown): boolean {
  return typeof mode === "string" && READ_ONLY_ANALYSIS_MODES.has(mode);
}

function hasGithubCompletionEvidence(result?: TaskResult): boolean {
  const output = result?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }

  const github = output.github;
  if (github && typeof github === "object" && !Array.isArray(github)) {
    const record = github as Record<string, unknown>;
    if (isHttpUrl(record.prUrl) || isHttpUrl(record.doneCommentUrl) || isHttpUrl(record.blockCommentUrl)) {
      return true;
    }
  }

  return (
    isHttpUrl(output.prUrl) ||
    isHttpUrl(output.doneCommentUrl) ||
    isHttpUrl(output.blockCommentUrl)
  );
}

function hasGithubNoPatchCompletionEvidence(result?: TaskResult): boolean {
  const output = result?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }

  const github = output.github;
  if (github && typeof github === "object" && !Array.isArray(github)) {
    const record = github as Record<string, unknown>;
    if (isHttpUrl(record.doneCommentUrl) || isHttpUrl(record.blockCommentUrl)) {
      return true;
    }
  }

  return isHttpUrl(output.doneCommentUrl) || isHttpUrl(output.blockCommentUrl);
}

// Read-only review lanes (analyze/verify/validate_change on a github read-only
// validation mode) deliver their result as a review verdict plus a reference to
// the review body, not as a Done/Block comment. A complete verdict is canonical
// completion evidence for those lanes. A review that produced no verdict (or no
// body reference) still fails closed, exactly like a missing Done/Block marker.
function hasGithubReviewVerdictEvidence(result?: TaskResult): boolean {
  const output = result?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }

  const review = output.review;
  if (review && typeof review === "object" && !Array.isArray(review)) {
    const record = review as Record<string, unknown>;
    if (isReviewVerdict(record.verdict) && hasReviewBodyRef(record.bodyUrl ?? record.bodyRef)) {
      return true;
    }
  }

  return isReviewVerdict(output.reviewVerdict) && hasReviewBodyRef(output.reviewBodyUrl ?? output.reviewBodyRef);
}

// Some read-only GitHub verification lanes are intentionally blocked before a
// GitHub comment can be produced, for example when the worker has no compatible
// read-only evidence executor. Treat the bounded preflight block packet as
// completion evidence so the broker stores the structured Block result instead
// of converting it into a transport-level task failure (#860).
function hasGithubStructuredBlockEvidence(result?: TaskResult): boolean {
  const output = result?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }

  return output.analysisStatus === "blocked"
    && output.analysisKind === "github_readonly_executor_preflight"
    && typeof output.blockReason === "string"
    && output.blockReason.trim().length > 0;
}

function isReviewVerdict(value: unknown): boolean {
  return typeof value === "string" && REVIEW_VERDICTS.has(value);
}

function hasReviewBodyRef(value: unknown): boolean {
  // A body reference can be the posted review/comment URL or a non-empty
  // evidence id/ref string. Anything empty is treated as no evidence.
  return typeof value === "string" && value.trim().length > 0;
}

function summarizeObservedCompletionEvidence(result?: TaskResult): Record<string, unknown> {
  const output = result?.output && typeof result.output === "object" && !Array.isArray(result.output)
    ? result.output as Record<string, unknown>
    : {};
  const github = output.github && typeof output.github === "object" && !Array.isArray(output.github)
    ? output.github as Record<string, unknown>
    : {};
  const runner = output.runner && typeof output.runner === "object" && !Array.isArray(output.runner)
    ? output.runner as Record<string, unknown>
    : {};

  return compactRecord({
    summary: safeLongDetailValue(result?.summary),
    note: safeLongDetailValue(result?.note),
    artifactIds: safeStringArray(result?.artifactIds),
    outputKeys: Object.keys(output).sort().slice(0, 40),
    startCommentUrl: safeLongDetailValue(output.startCommentUrl ?? github.startCommentUrl),
    githubStartCommentUrl: safeLongDetailValue(github.startCommentUrl),
    doneCommentUrl: safeLongDetailValue(output.doneCommentUrl ?? github.doneCommentUrl),
    blockCommentUrl: safeLongDetailValue(output.blockCommentUrl ?? github.blockCommentUrl),
    prUrl: safeLongDetailValue(output.prUrl ?? github.prUrl),
    runnerStatus: safeLongDetailValue(runner.status ?? output.runnerStatus),
    runnerArtifacts: safeStringArray(runner.artifacts ?? output.runnerArtifacts),
    logPath: safeLongDetailValue(output.logPath ?? runner.logPath),
    logUrl: safeLongDetailValue(output.logUrl ?? runner.logUrl),
    workDir: safeLongDetailValue(output.workDir ?? runner.workDir),
    analysisStatus: safeLongDetailValue(output.analysisStatus),
    analysisKind: safeLongDetailValue(output.analysisKind),
    blockReason: safeLongDetailValue(output.blockReason),
  });
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function safeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 20);
}

function safeLongDetailValue(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.slice(0, 500);
}

function validateCompletionReceipt(result?: TaskResult): TaskError | null {
  const output = result?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }

  const receipt = output.receipt;
  const receiptRecord = receipt && typeof receipt === "object" && !Array.isArray(receipt)
    ? receipt as Record<string, unknown>
    : undefined;
  const status = receiptRecord?.status ?? output.receiptStatus;
  if (status !== undefined && !isCanonicalReceiptStatus(status)) {
    return {
      code: "github_completion_receipt_invalid",
      message:
        "github-origin propose_patch completion receipt status must be accepted, sent/provider_sent/provider_accepted, current_session_visible, operator_visible, timed_out, stale, or failed",
      details: { receiptStatus: safeDetailValue(status) },
    };
  }

  const evidence = receiptRecord?.evidence ?? output.receiptEvidence;
  if (evidence !== undefined && !isReceiptAckEvidence(evidence)) {
    return {
      code: "github_completion_receipt_invalid",
      message:
        "github-origin propose_patch completion receipt evidence must be current_session_visible, operator_visible, or operator_confirmed; provider send success is not receipt evidence",
      details: { receiptEvidence: safeDetailValue(evidence) },
    };
  }

  return null;
}

function isCanonicalReceiptStatus(value: unknown): boolean {
  return typeof value === "string" && RECEIPT_STATUSES.has(value);
}

function isReceiptAckEvidence(value: unknown): boolean {
  return typeof value === "string" && RECEIPT_ACK_EVIDENCE.has(value);
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

function safeDetailValue(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 80) : typeof value;
}
