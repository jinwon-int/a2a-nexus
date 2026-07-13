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
    .replace(/(Authorization:\s*Bearer\s+)[^\s,;]+/gi, "$1" + REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, REDACTED)
    .replace(/\b(TOKEN|SECRET|KEY|PASSWORD|API[_-]?KEY|APIKEY|ACCESS_TOKEN|EDGE_SECRET)=([^\s,;&]+)/gi, "$1=" + REDACTED)
    .replace(/([?&](?:token|access_token|api_key|apikey|secret|key|password)=)[^&\s,;]+/gi, "$1" + REDACTED)
    .replace(/((?:"|')?(?:token|access_token|api_key|apikey|secret|key|password)(?:"|')?\s*:\s*(?:"|')?)[^"'\s,;}]+/gi, "$1" + REDACTED)
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED);
}

export function boundText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length > maxChars) return { text: value.slice(0, maxChars), truncated: true };
  return { text: value, truncated: false };
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
