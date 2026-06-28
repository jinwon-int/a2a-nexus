// Shared structural type guards for the A2A plugin normalizers/adapters.
// Consolidated from copy-pasted local definitions (repo-cleanup survey).

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Trim a value to a non-empty string, or undefined. Accepts unknown so it can
// also be used on already-typed string|undefined values (the previous
// copy-pasted local definitions used both signatures, with identical behavior).
export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
