// Shared value type-guards for the broker core. Consolidated from 60 copy-pasted
// local `isRecord` definitions (repo-cleanup survey). All copies were one of two
// byte variants that differ only in operand order and are behaviorally identical.

/** Narrow an unknown value to a plain (non-array) object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
