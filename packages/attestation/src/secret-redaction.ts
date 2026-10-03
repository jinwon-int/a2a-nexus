// Shared secret redactor for repo-visible / GitHub egress text (#2256 A4).
//
// Moved verbatim from the broker's `core/task-error-details.ts`
// (`redactSecretText`) so every broker GitHub egress point (failure readback,
// status projections, terminal-brief evidence, cross-broker handoff) uses one
// implementation. Marker style is `<redacted…>`; rules track the runner's
// `redactSecrets` (packages/docker-runner/src/redaction.ts).
//
// Deliberately NO generic long-token / long-hex rule: 40-hex commit SHAs and
// sha256 digests are evidence and must survive. This is the difference from
// `redactSecretsText` (worker-subagent-redaction), which hides any
// `[A-Za-z0-9_-]{40,}` run for sub-agent artifacts and stays separate.

// Built by concatenation so the patterns themselves cannot trip secret
// scanners; hoisted so redactSecrets does not recompile them per call.
const GITHUB_CLASSIC_TOKEN_PATTERN = new RegExp("gh[pousr]" + "_" + "[A-Za-z0-9_]{20,}", "g");
const GITHUB_FINE_GRAINED_TOKEN_PATTERN = new RegExp("github" + "_pat" + "_" + "[A-Za-z0-9_]{20,}", "g");

/**
 * Redact credentials, provider targets, personal contacts and private host
 * paths from text that may leave the broker (GitHub comments, failure
 * readback). Commit SHAs, no-reply/SSH addresses, versions, ISO dates and
 * durations are preserved.
 */
export function redactSecrets(value: string): string {
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
    // Personal addresses only: SSH remotes (`git@host:`) and no-reply
    // addresses (commit trailers, GitHub noreply) are not personal contacts.
    .replace(/\b(?!git@[A-Z0-9.-]+:)(?!noreply@)[A-Z0-9._%+-]+@(?!users\.noreply\.github\.com\b(?!\.))[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
    // Phone-shaped only: not part of a version (`1.4.0+2026…`), not an ISO
    // date/offset (`+2026-09-28 …`), not a duration/number suffix (`+123ms`).
    .replace(/(?<![\d.+])\+(?!\d{4}-\d{2}-\d{2})\d[\d .()-]{7,}\d(?!\w|[.:]\w|[ ()-]*\d)/g, "<redacted-phone>")
    // Private host paths that are useful locally but unsafe/noisy in repo-visible readback.
    .replace(/\/root\/\.openclaw(?:\/[^\s"',}]+)?/g, "<redacted-private-path>")
    .replace(/\/tmp\/openclaw-agent-workspace(?:\/[^\s"',}]+)?/g, "<redacted-private-path>")
    .replace(/\/(?:home|Users)\/[^\s"',}]+(?:\/[^\s"',}]+)?/g, "<redacted-private-path>")
    .replace(/file:\/\/\/[^\s"')`,}]+/g, "file:///<redacted-private-path>");
}
