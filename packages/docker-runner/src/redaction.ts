export const RESULT_STREAM_LIMIT = 8_000;

export function redactSecrets(value: string): string {
  return value
    // GitHub tokens (classic + fine-grained + PAT v2)
    .replace(new RegExp("gh[pousr]" + "_" + "[A-Za-z0-9_]{20,}", "g"), "<redacted-github-token>")
    .replace(new RegExp("github" + "_pat" + "_" + "[A-Za-z0-9_]{20,}", "g"), "<redacted-github-token>")
    .replace(/\/root\/\.openclaw(?:\/[^\s"',}]+)?/g, "<openclaw-dir>")
    .replace(/\/tmp\/openclaw-agent-workspace(?:\/[^\s"',}]+)?/g, "<openclaw-workspace>")
    // xai / supermemory / openai API key patterns (synthetic format)
    // Must fire BEFORE generic key=value redaction to catch the full key.
    .replace(/xai-[A-Za-z0-9_-]{40,}/g, "<redacted-api-key>")
    .replace(/sm_[A-Za-z0-9_-]{40,}/g, "<redacted-api-key>")
    .replace(/sk-[A-Za-z0-9_-]{32,}/g, "<redacted-api-key>")
    // x-access-token in URLs
    .replace(/x-access-token:[^@\s]+@github\.com/g, "x-access-token:<redacted>@github.com")
    // oauth_token in YAML/JSON
    .replace(/(oauth_token:\s*)\S+/gi, "$1<redacted>")
    // Authorization / Bearer headers
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1<redacted>")
    .replace(/(gh auth login --with-token\s+)\S+/gi, "$1<redacted>")
    // Generic key=value and JSON/YAML-style secrets (after API key patterns)
    .replace(/((?:token|password|secret|api[_-]?key)=)(?!<redacted)[^\s]+/gi, "$1<redacted>")
    .replace(/((?:token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?)(?!<redacted)[^"'\s,}]+/gi, "$1<redacted>")
    // Shell variable assignments with secrets
    .replace(/((?:GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|A2A_TOKEN)=)['"]?[^'"\s]+['"]?/gi, "$1<redacted>");
}

export function redactAndBound(value: string, limit = RESULT_STREAM_LIMIT): string {
  const redacted = redactSecrets(value);
  if (redacted.length <= limit) return redacted;
  const omitted = redacted.length - limit;
  return `${redacted.slice(0, limit)}\n<truncated ${omitted} chars>`;
}
