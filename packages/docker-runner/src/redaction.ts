export const RESULT_STREAM_LIMIT = 8_000;

export function redactSecrets(value: string): string {
  const brokerMarker = "[redacted]";
  return value.split(brokerMarker).map(redactSecretsSegment).join(brokerMarker);
}

function redactSecretsSegment(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "<redacted-control>")
    .replace(/\b(TOKEN|SECRET|KEY|PASSWORD|API[_-]?KEY|APIKEY|ACCESS_TOKEN|EDGE_SECRET)\s*=\s*"(?:\\.|[^"\\\r\n])*"/gi, '$1="<redacted>"')
    .replace(/\b(TOKEN|SECRET|KEY|PASSWORD|API[_-]?KEY|APIKEY|ACCESS_TOKEN|EDGE_SECRET)\s*=\s*'(?:\\.|[^'\\\r\n])*'/gi, "$1='<redacted>'")
    .replace(/(["'](?:token|access_token|api_key|apikey|secret|key|password)["']\s*:\s*)"(?:\\.|[^"\\\r\n])*"/gi, '$1"<redacted>"')
    .replace(/(["'](?:token|access_token|api_key|apikey|secret|key|password)["']\s*:\s*)'(?:\\.|[^'\\\r\n])*'/gi, "$1'<redacted>'")
    // GitHub tokens (classic + fine-grained + PAT v2)
    .replace(new RegExp("gh[pousr]" + "_" + "[A-Za-z0-9_]{20,}", "g"), "<redacted-github-token>")
    .replace(new RegExp("github" + "_pat" + "_" + "[A-Za-z0-9_]{20,}", "g"), "<redacted-github-token>")
    .replace(/\/root\/\.openclaw(?:\/[^\s"',}]+)?/g, "<openclaw-dir>")
    .replace(/\/root\/\.hermes(?:\/[^\s"',}]+)?/g, "<private-dir>")
    .replace(/\/tmp\/openclaw-agent-workspace(?:\/[^\s"',}]+)?/g, "<openclaw-workspace>")
    .replace(/\/(?:home|Users)\/[^\s"',}]+(?:\/[^\s"',}]+)?/g, "<private-dir>")
    .replace(/\btelegram:-?\d{6,}\b/gi, "telegram:<redacted-target>")
    .replace(/\b(?:chat[_-]?id|thread[_-]?id)[:=]-?\d{6,}\b/gi, (match) => `${match.split(/[:=]/)[0]}=<redacted-target>`)
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

function boundUtf8(value: string, maxBytes: number): string {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let output = "";
  let used = 0;
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (used + bytes > limit) break;
    output += codePoint;
    used += bytes;
  }
  return output;
}

export function redactAndBound(value: string, limit = RESULT_STREAM_LIMIT): string {
  const maxBytes = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const redacted = redactSecrets(value);
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return redacted;
  let marker = `\n<truncated ${redacted.length} chars>`;
  if (Buffer.byteLength(marker, "utf8") >= maxBytes) return boundUtf8(redacted, maxBytes);
  let prefix = boundUtf8(redacted, maxBytes - Buffer.byteLength(marker, "utf8"));
  marker = `\n<truncated ${redacted.length - prefix.length} chars>`;
  prefix = boundUtf8(redacted, maxBytes - Buffer.byteLength(marker, "utf8"));
  return `${prefix}${marker}`;
}
