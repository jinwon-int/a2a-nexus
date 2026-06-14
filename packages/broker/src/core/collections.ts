// Shared collection helpers for the broker core. Consolidated from copy-pasted
// local definitions (repo-cleanup survey).

/** Return the input with duplicate values removed, preserving first-seen order. */
export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
