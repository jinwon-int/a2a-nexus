// Shared programmatic redaction + byte-bound for sub-agent artifacts.
//
// One implementation of the redaction mechanism, used by the context-brief
// (finalizer input) and the redaction gate (all sub-agent output). Patterns are
// consistent with the repo's established redactors (round-status
// redactSensitiveText, patch-bridge redactSecrets): bearer/auth, KEY=VALUE
// secrets, URL and JSON secret values, gh-token and long token-shaped strings.

const REDACTED = "[redacted]";

export function redactSecretsText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "<redacted-control>")
    .replace(/\b(TOKEN|SECRET|KEY|PASSWORD|API[_-]?KEY|APIKEY|ACCESS_TOKEN|EDGE_SECRET)\s*=\s*"(?:\\.|[^"\\\r\n])*"/gi, '$1="' + REDACTED + '"')
    .replace(/\b(TOKEN|SECRET|KEY|PASSWORD|API[_-]?KEY|APIKEY|ACCESS_TOKEN|EDGE_SECRET)\s*=\s*'(?:\\.|[^'\\\r\n])*'/gi, "$1='" + REDACTED + "'")
    .replace(/(["'](?:token|access_token|api_key|apikey|secret|key|password)["']\s*:\s*)"(?:\\.|[^"\\\r\n])*"/gi, '$1"' + REDACTED + '"')
    .replace(/(["'](?:token|access_token|api_key|apikey|secret|key|password)["']\s*:\s*)'(?:\\.|[^'\\\r\n])*'/gi, "$1'" + REDACTED + "'")
    .replace(/(Authorization:\s*Bearer\s+)[^\s"'}]+/gi, "$1" + REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, REDACTED)
    .replace(/\b(TOKEN|SECRET|KEY|PASSWORD|API[_-]?KEY|APIKEY|ACCESS_TOKEN|EDGE_SECRET)=([^\s,;&]+)/gi, "$1=" + REDACTED)
    .replace(/([?&](?:token|access_token|api_key|apikey|secret|key|password)=)[^&\s,;]+/gi, "$1" + REDACTED)
    .replace(/((?:"|')?(?:token|access_token|api_key|apikey|secret|key|password)(?:"|')?\s*:\s*(?:"|')?)[^"'\s,;}]+/gi, "$1" + REDACTED)
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED)
    .replace(/\btelegram:-?\d{6,}\b/gi, "telegram:<redacted-target>")
    .replace(/\b(?:chat[_-]?id|thread[_-]?id)[:=]-?\d{6,}\b/gi, (match) => `${match.split(/[:=]/)[0]}=<redacted-target>`)
    .replace(/\b(?:discord|slack):#[A-Za-z0-9._-]+\b/gi, (match) => `${match.split(":")[0]}:#<redacted-target>`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
    .replace(/\+\d[\d .()-]{7,}\d/g, "<redacted-phone>")
    .replace(/\/root\/\.(?:openclaw|hermes)(?:\/[^\s"',}]+)?/g, "<redacted-private-path>")
    .replace(/\/tmp\/openclaw-agent-workspace(?:\/[^\s"',}]+)?/g, "<redacted-private-path>")
    .replace(/\/(?:home|Users)\/[^\s"',}]+(?:\/[^\s"',}]+)?/g, "<redacted-private-path>")
    .replace(/file:\/\/\/[^\s"')`,}]+/g, "file:///<redacted-private-path>");
}

export function boundText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  if (Buffer.byteLength(value, "utf8") <= limit) return { text: value, truncated: false };
  let text = "";
  let used = 0;
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    if (used + bytes > limit) break;
    text += codePoint;
    used += bytes;
  }
  return { text, truncated: true };
}

export function redactAndBound(value: string, maxChars: number): string {
  return boundText(redactSecretsText(value), maxChars).text;
}

export interface RedactAndBoundReport {
  cleaned: string;
  redacted: boolean;
  truncated: boolean;
}

export function redactAndBoundReport(value: string, maxChars: number): RedactAndBoundReport {
  const masked = redactSecretsText(value);
  const bounded = boundText(masked, maxChars);
  return {
    cleaned: bounded.text,
    redacted: masked !== value,
    truncated: bounded.truncated,
  };
}
