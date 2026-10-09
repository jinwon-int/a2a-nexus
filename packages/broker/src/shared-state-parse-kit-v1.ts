/**
 * Shared parse helpers for the `a2a.shared-state.*` runtime contract modules.
 *
 * Every V1 contract module (storage contract, keyspace, time, idempotency,
 * outbox, observability) reports failures as the same shape — a frozen
 * `{ code, path }` error inside an `{ ok: false, error }` result — and used to
 * carry its own byte-identical copy of these helpers. This kit holds the
 * single generic version of each; the modules keep their own closed error-code
 * vocabularies by instantiating `Code`.
 *
 * Behaviour is identical to the per-module copies it replaces. The kit is
 * pure (no I/O, no clock, no configuration).
 */

import type { z } from "zod";

export type SharedStateParsePathV1 = readonly (string | number)[];

export interface SharedStateParseErrorV1<Code extends string> {
  readonly code: Code;
  readonly path: SharedStateParsePathV1;
}

export interface SharedStateParseFailureV1<Code extends string> {
  readonly ok: false;
  readonly error: SharedStateParseErrorV1<Code>;
}

/** Error codes `mapZodError` can produce; every contract vocabulary includes them. */
export type SharedStateZodMappedErrorCodeV1 =
  | "invalid_type"
  | "invalid_value"
  | "unknown_field";

/** Recursively freezes a plain value tree in place and returns it. */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

/** Builds the frozen `{ ok: false, error: { code, path } }` failure result. */
export function errorResult<Code extends string>(
  code: Code,
  path: SharedStateParsePathV1 = [],
): SharedStateParseFailureV1<Code> {
  return {
    ok: false,
    error: Object.freeze({ code, path: Object.freeze([...path]) }),
  };
}

/** Index of the first value that repeats an earlier one, or `null`. */
export function firstDuplicate(values: readonly string[]): number | null {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    if (seen.has(values[index])) return index;
    seen.add(values[index]);
  }
  return null;
}

/**
 * Code-unit-first key of `value` that is not in `allowed`, or `null`. Single
 * pass (same pick as `filter().sort()[0]`); the common all-known path
 * allocates nothing.
 */
export function firstUnknownField(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  let first: string | null = null;
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    if (first === null || key < first) first = key;
  }
  return first;
}

// Field names repeat heavily across commands, so memoize normalization.
// Keys are caller-controlled: the cache clears at capacity instead of
// growing without bound.
const normalizedFieldNameCache = new Map<string, string>();

/** Lower-cases and strips `-`/`_` so `task-id`, `task_id`, `taskId` compare equal. */
export function normalizedFieldName(value: string): string {
  let normalized = normalizedFieldNameCache.get(value);
  if (normalized === undefined) {
    normalized = value.replace(/[-_]/g, "").toLowerCase();
    if (normalizedFieldNameCache.size >= 4096) normalizedFieldNameCache.clear();
    normalizedFieldNameCache.set(value, normalized);
  }
  return normalized;
}

/**
 * Maps a zod error to the deterministic first issue (path, then code order)
 * using the three-code vocabulary shared by the idempotency and outbox
 * contracts. The storage contract and observability modules keep their own
 * richer mappings (discriminant / range / enum codes).
 */
export function mapZodError(
  error: z.ZodError,
): SharedStateParseErrorV1<SharedStateZodMappedErrorCodeV1> {
  const issues = [...error.issues].sort((left, right) => {
    const leftPath = JSON.stringify(left.path);
    const rightPath = JSON.stringify(right.path);
    return leftPath.localeCompare(rightPath) ||
      left.code.localeCompare(right.code);
  });
  const issue = issues[0];
  if (!issue) return Object.freeze({ code: "invalid_value", path: [] });
  const path = issue.path.map((segment) =>
    typeof segment === "symbol"
      ? (segment.description ?? "symbol")
      : segment
  );
  if (issue.code === "unrecognized_keys") {
    const key = [...issue.keys].sort()[0];
    return Object.freeze({
      code: "unknown_field",
      path: Object.freeze([...path, key]),
    });
  }
  return Object.freeze({
    code: issue.code === "invalid_type" ? "invalid_type" : "invalid_value",
    path: Object.freeze(path),
  });
}
