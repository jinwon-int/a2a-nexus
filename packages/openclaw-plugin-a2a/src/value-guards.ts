// Shared structural type guards for the A2A plugin normalizers/adapters.
// Consolidated from copy-pasted local definitions (repo-cleanup survey).

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
