import type { TaskError } from "./types.js";

export const FAILURE_READBACK_STAGES = [
  "dispatch",
  "projection",
  "handler",
  "acceptance",
  "verification",
] as const;

export type FailureReadbackStage = typeof FAILURE_READBACK_STAGES[number];

/**
 * Why a handler lane failed, split by the two clusters that share the
 * `handler_exit_nonzero` exit code but have nothing else in common (#1597,
 * routed from #1725 finding 2).
 *
 * The 2026-08-03 audit measured 29 `handler_exit_nonzero` failures in a clean
 * bimodal distribution: 12 that died in <=10s totalling 54 seconds, and 17 that
 * burned 87.3 lane-minutes averaging 308s. Same code, opposite causes and three
 * orders of magnitude apart in cost — and the list API surfaced neither
 * `nestedError` nor anything else that told them apart, so identifying the
 * cause meant reading task records one at a time.
 *
 * - `handler_missing`: the artifact or command was absent, so nothing ran.
 *   Fails in seconds. Re-running on the same worker cannot help; the worker
 *   needs its artifact fixed.
 * - `handler_bridge_error`: the bridge ran and produced output that could not
 *   be used. Burns the full provider budget before failing.
 *
 * Unrecognised failures stay unclassified rather than being guessed into one
 * of these buckets — a wrong label is worse than no label here.
 */
export const FAILURE_CLASSES = ["handler_missing", "handler_bridge_error"] as const;

export type FailureClass = typeof FAILURE_CLASSES[number];

const FAILURE_CLASS_SET = new Set<string>(FAILURE_CLASSES);

export const FAILURE_EXCERPT_MAX_LINES = 20;
export const FAILURE_EXCERPT_MAX_CHARS = 4_000;

const FAILURE_READBACK_STAGE_SET = new Set<string>(FAILURE_READBACK_STAGES);

export interface FailureReadbackDetails {
  /** Failure phase used by finalizers when classifying failed lanes. */
  stage?: FailureReadbackStage;
  /** Bounded, operator-safe excerpt. Raw logs/prompts/secrets must never be stored here. */
  excerpt?: string;
  /**
   * Which handler failure cluster this is. A closed vocabulary, so it is safe
   * to project on list read paths where the free-form details are not.
   */
  failureClass?: FailureClass;
}

// Built by concatenation so the patterns themselves cannot trip secret
// scanners; hoisted so redactSecrets does not recompile them per call.
const GITHUB_CLASSIC_TOKEN_PATTERN = new RegExp("gh[pousr]" + "_" + "[A-Za-z0-9_]{20,}", "g");
const GITHUB_FINE_GRAINED_TOKEN_PATTERN = new RegExp("github" + "_pat" + "_" + "[A-Za-z0-9_]{20,}", "g");

function redactSecrets(value: string): string {
  return value
    // GitHub tokens (classic, fine-grained, app/user/server tokens).
    .replace(GITHUB_CLASSIC_TOKEN_PATTERN, "<redacted-github-token>")
    .replace(GITHUB_FINE_GRAINED_TOKEN_PATTERN, "<redacted-github-token>")
    // Common model/API key patterns.
    .replace(/xai-[A-Za-z0-9_-]{40,}/g, "<redacted-api-key>")
    .replace(/sm_[A-Za-z0-9_-]{40,}/g, "<redacted-api-key>")
    .replace(/sk-[A-Za-z0-9_-]{32,}/g, "<redacted-api-key>")
    // Authorization headers and token-bearing command snippets.
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/(gh auth login --with-token\s+)\S+/gi, "$1<redacted>")
    // Generic key=value and JSON/YAML-style secrets.
    .replace(/((?:token|password|secret|api[_-]?key)=)(?!<redacted)[^\s]+/gi, "$1<redacted>")
    .replace(/((?:token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?)(?!<redacted)[^"'\s,}]+/gi, "$1<redacted>")
    .replace(/((?:GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|A2A_TOKEN)=)['"]?[^'"\s]+['"]?/gi, "$1<redacted>")
    // Provider targets / personal contact handles are not needed for failure classification.
    .replace(/\btelegram:-?\d{6,}\b/gi, "telegram:<redacted-target>")
    .replace(/\b(?:chat[_-]?id|thread[_-]?id)[:=]-?\d{6,}\b/gi, (match) => `${match.split(/[:=]/)[0]}=<redacted-target>`)
    .replace(/\b(?:discord|slack):#[A-Za-z0-9._-]+\b/gi, (match) => `${match.split(":")[0]}:#<redacted-target>`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
    .replace(/\+\d[\d .()-]{7,}\d/g, "<redacted-phone>")
    // Private host paths that are useful locally but unsafe/noisy in repo-visible readback.
    .replace(/\/root\/\.openclaw(?:\/[^\s"',}]+)?/g, "<redacted-private-path>")
    .replace(/\/tmp\/openclaw-agent-workspace(?:\/[^\s"',}]+)?/g, "<redacted-private-path>")
    .replace(/\/(?:home|Users)\/[^\s"',}]+(?:\/[^\s"',}]+)?/g, "<redacted-private-path>")
    .replace(/file:\/\/\/[^\s"')`,}]+/g, "file:///<redacted-private-path>");
}

export function redactAndBoundFailureExcerpt(value: string, options?: { maxLines?: number; maxChars?: number }): string {
  const maxLines = options?.maxLines ?? FAILURE_EXCERPT_MAX_LINES;
  const maxChars = options?.maxChars ?? FAILURE_EXCERPT_MAX_CHARS;
  const redacted = redactSecrets(value);
  const lines = redacted.split(/\r?\n/);
  if (lines.length <= maxLines && redacted.length <= maxChars) {
    return redacted;
  }

  // Keep the head for context AND the tail for the failure itself (#1610):
  // handler errors are almost always at the end of the output, so head-only
  // truncation lost the actual cause in production.
  const headLines = Math.max(1, Math.floor(maxLines / 4));
  const tailLines = Math.max(1, maxLines - headLines);
  const head = lines.slice(0, headLines);
  const tail = lines.slice(Math.max(headLines, lines.length - tailLines));
  const omittedLines = Math.max(0, lines.length - head.length - tail.length);
  const joined = [...head, `<truncated ${omittedLines} line${omittedLines === 1 ? "" : "s"}>`, ...tail].join("\n");
  if (joined.length <= maxChars) {
    return joined;
  }
  const headChars = Math.max(64, Math.floor(maxChars / 4));
  const tailChars = Math.max(64, maxChars - headChars);
  const omittedChars = Math.max(0, joined.length - headChars - tailChars);
  return `${joined.slice(0, headChars)}\n<truncated ${omittedChars} char${omittedChars === 1 ? "" : "s"}>\n${joined.slice(joined.length - tailChars)}`;
}

export function normalizeFailureReadbackStage(value: unknown): FailureReadbackStage | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return FAILURE_READBACK_STAGE_SET.has(normalized) ? normalized as FailureReadbackStage : undefined;
}

export function normalizeFailureClass(value: unknown): FailureClass | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return FAILURE_CLASS_SET.has(normalized) ? normalized as FailureClass : undefined;
}

export function normalizeFailureReadbackDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const normalized: Record<string, unknown> = { ...details };
  const stage = normalizeFailureReadbackStage(details.stage);
  if (stage) normalized.stage = stage;
  else if (details.stage !== undefined) delete normalized.stage;
  if (typeof details.excerpt === "string") {
    normalized.excerpt = redactAndBoundFailureExcerpt(details.excerpt);
  } else if (details.excerpt !== undefined) {
    delete normalized.excerpt;
  }
  // Fail closed on the class: a worker-supplied value outside the vocabulary is
  // dropped, never stored. The field is projected on public list read paths, so
  // it must not become a free-text channel.
  const failureClass = normalizeFailureClass(details.failureClass);
  if (failureClass) normalized.failureClass = failureClass;
  else if (details.failureClass !== undefined) delete normalized.failureClass;
  return Object.keys(normalized).length ? normalized : undefined;
}

export function failureReadbackFromError(error: TaskError | undefined): Record<string, unknown> | undefined {
  const details = error?.details;
  if (!details) return undefined;
  const stage = normalizeFailureReadbackStage(details.stage);
  const excerpt = typeof details.excerpt === "string" ? details.excerpt : undefined;
  const failureClass = normalizeFailureClass(details.failureClass);
  if (!stage && !excerpt && !failureClass) return undefined;
  return {
    ...(stage ? { stage } : {}),
    ...(excerpt ? { excerpt } : {}),
    ...(failureClass ? { failureClass } : {}),
  };
}
