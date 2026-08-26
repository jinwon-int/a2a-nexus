// Generic, dependency-free utilities used by the broker core. Extracted from
// broker.ts (a large single-class module) to give its pure helpers a focused
// home and begin reducing that file's size without touching broker state.
//
// Only type-free utilities live here. Helpers that depend on broker domain
// types (task/worker/proposal records, filters, profiling shapes) stay in
// broker.ts next to the class that uses them.

export function isoNow(): string {
  return new Date().toISOString();
}

export function formatAgeMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ${min % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function uniqueIds(values: string[]): string[] {
  return [...new Set(values)];
}

export function sortedCopy<T>(values: Iterable<T>, compare: (a: T, b: T) => number): T[] {
  const items = [...values];
  items.sort(compare);
  return items;
}

export function ageSecFromIso(iso: string, nowMs: number): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

// KNOWN QUIRK (deliberately preserved): this comparator never returns 0, which
// violates the comparator contract for equal createdAt values. Several read
// paths and tests pin the resulting whole-array ordering (an exact reversal of
// insertion order for the common ascending-with-ties input), an id tie-break
// would order same-timestamp records by random UUID, and a 0-return would let
// stable sort produce a tie-pattern-dependent order instead. Fixing this needs
// an explicit tie semantic (newest-first, later-inserted first) threaded
// through the newest-first read paths as its own change.
export function sortNewestFirst<T extends { createdAt: string }>(a: T, b: T): number {
  return a.createdAt < b.createdAt ? 1 : -1;
}

/** Tally items by a string key, returning per-key counts. */
export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    result[k] = (result[k] ?? 0) + 1;
  }
  return result;
}
