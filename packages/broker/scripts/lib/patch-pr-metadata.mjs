// #2565/#2568: PR title and issue-link rules shared by the A2A patch paths.
//
// The docker-runner default pipeline (packages/docker-runner/src/task-normalizer.ts
// normalizePatchTitle / normalizeIssueLink) and the host patch bridges
// (claude single-shot, piri) must agree:
//   - title: one line, control characters removed, capped at 120 code points;
//     blank / non-string -> undefined (caller keeps its legacy title).
//   - issue link: "closes" | "refs"; anything else -> "refs". The finalizer owns
//     issue closure (owner decision 2026-11-16 KST), so the default never closes.
//
// The handler (a2a-task-handler.mjs runOpenClawBridgeCore) writes
// `Issue link: <refs|closes>` and `Task title: <one line>` into the bridge
// prompt BEFORE the free-form task message and payload, so the first line-start
// occurrence is always the handler-authored value.

export const PATCH_TITLE_MAX_LENGTH = 120;
export const DEFAULT_ISSUE_LINK = "refs";

export function normalizePatchTitle(value) {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= PATCH_TITLE_MAX_LENGTH) return cleaned;
  return `${codePoints.slice(0, PATCH_TITLE_MAX_LENGTH - 1).join("").trimEnd()}…`;
}

export function normalizeIssueLink(value) {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "closes" || normalized === "refs") return normalized;
  }
  return DEFAULT_ISSUE_LINK;
}

/** `Refs #N` / `Closes #N` (ref is `#N` or `owner/repo#N`). */
export function issueLinkLine(issueLink, ref) {
  return `${normalizeIssueLink(issueLink) === "closes" ? "Closes" : "Refs"} ${ref}`;
}

/**
 * Read the handler-authored `Task title:` and `Issue link:` lines from a bridge
 * prompt. Only the first line-start occurrence counts; values never span lines.
 */
export function parsePatchPrMetadata(message) {
  const text = typeof message === "string" ? message : "";
  const titleMatch = /^Task title:[ \t]*([^\r\n]*)$/m.exec(text);
  const linkMatch = /^Issue link:[ \t]*([^\r\n]*)$/m.exec(text);
  return {
    title: normalizePatchTitle(titleMatch ? titleMatch[1] : undefined),
    issueLink: normalizeIssueLink(linkMatch ? linkMatch[1] : undefined),
  };
}
