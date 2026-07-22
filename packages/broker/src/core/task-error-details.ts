import type { TaskError } from "./types.js";

export const FAILURE_READBACK_STAGES = [
  "dispatch",
  "projection",
  "handler",
  "acceptance",
  "verification",
] as const;

export type FailureReadbackStage = typeof FAILURE_READBACK_STAGES[number];

export const FAILURE_EXCERPT_MAX_LINES = 20;
export const FAILURE_EXCERPT_MAX_CHARS = 4_000;

const FAILURE_READBACK_STAGE_SET = new Set<string>(FAILURE_READBACK_STAGES);

export interface FailureReadbackDetails {
  /** Failure phase used by finalizers when classifying failed lanes. */
  stage?: FailureReadbackStage;
  /** Bounded, operator-safe excerpt. Raw logs/prompts/secrets must never be stored here. */
  excerpt?: string;
}

function redactSecrets(value: string): string {
  return value
    // GitHub tokens (classic, fine-grained, app/user/server tokens).
    .replace(new RegExp("gh[pousr]" + "_" + "[A-Za-z0-9_]{20,}", "g"), "<redacted-github-token>")
    .replace(new RegExp("github" + "_pat" + "_" + "[A-Za-z0-9_]{20,}", "g"), "<redacted-github-token>")
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
  return Object.keys(normalized).length ? normalized : undefined;
}

export function failureReadbackFromError(error: TaskError | undefined): Record<string, unknown> | undefined {
  const details = error?.details;
  if (!details) return undefined;
  const stage = normalizeFailureReadbackStage(details.stage);
  const excerpt = typeof details.excerpt === "string" ? details.excerpt : undefined;
  if (!stage && !excerpt) return undefined;
  return { ...(stage ? { stage } : {}), ...(excerpt ? { excerpt } : {}) };
}
