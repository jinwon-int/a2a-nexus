// Shared text-value helpers for the broker core. Consolidated from copy-pasted
// local definitions (repo-cleanup survey). Note: a few modules intentionally
// keep a *different* optionalString that returns the value untrimmed — those
// are NOT migrated here.

/** Trim a string value; return undefined for non-strings or blank/whitespace. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
