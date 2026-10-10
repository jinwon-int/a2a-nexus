// Shared value type-guards for the broker core. Consolidated from 60 copy-pasted
// local `isRecord` definitions (repo-cleanup survey). All copies were one of two
// byte variants that differ only in operand order and are behaviorally identical.

import { createHash } from "node:crypto";

/** Narrow an unknown value to a plain (non-array) object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Canonical deterministic serializer for hash/idempotency-key seeds (#2047).
 *
 * Consolidated from 24 copy-pasted local `stableStringify` definitions across
 * `core/`, `github/` and `docker-runner`. Those copies formed five byte
 * variants that differ only in brace style, parameter names and the order of
 * the `Array.isArray` test; a 50,000-input differential fuzz proved all 24
 * emit byte-identical output, so replacing them with this function cannot move
 * any already-published `sha256(stableStringify(...))` digest.
 *
 * Deliberately NOT `JSON.stringify` with a replacer. The behaviour below is
 * load-bearing for the existing evidence/attestation digests and must not be
 * "cleaned up":
 *   - object keys are emitted in `Array.prototype.sort()` (UTF-16 code-unit)
 *     order, so `"10"` sorts before `"2"`;
 *   - `undefined` members are *retained* as the literal token `undefined`
 *     (from `JSON.stringify(undefined)` interpolated into a template string),
 *     rather than dropped as `JSON.stringify` would drop them;
 *   - `toJSON()` is never consulted, because objects are walked structurally;
 *   - arrays serialize holes/`undefined` as empty slots, not as `null`;
 *   - cyclic input throws `RangeError` (unbounded recursion) rather than
 *     `TypeError`.
 *
 * The one copy that is NOT this variant — `github/terminal-brief-evidence.ts`,
 * which sorts into a new object and then calls `JSON.stringify` — differs on
 * every one of the points above and seeds `manifestSha256` for comment markers
 * already published to GitHub. It is intentionally left un-consolidated; see
 * the note on `stableStringify` in that file.
 *
 * `core/value-guards.test.ts` pins each of these behaviours.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * Deterministic content-addressed id: `<prefix>-<first 24 hex of
 * sha256(stableStringify(value))>` (#2350 A7).
 *
 * Consolidated from 14 byte-identical local `stableId` copies across the
 * `core/orchestration-intelligence-*` modules. Because it is a pure function of
 * `stableStringify` (pinned above), moving it cannot change any id already
 * emitted into evidence packets. The two remaining local `stableId`s
 * (`a2a-dialectic-lite-finalizer.ts`, `terminal-event-outbox.ts`) are different
 * variants and are intentionally left alone.
 */
export function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}

/**
 * Approval-evidence timing/coverage predicates (#2350 A7). Consolidated from
 * three byte-identical copies in the `orchestration-intelligence-*-approval-
 * decision-evidence` modules; `scopeMatches` there was a pure alias of
 * `coversAll` and now calls it directly.
 *
 * `approvedAtValid`: both timestamps parse and the approval is not later than
 * the packet's `generatedAt`. `approvalNotExpired`: no expiry means never
 * expired; otherwise the expiry parses and lies strictly after `generatedAt`.
 * Unparseable input fails closed in both.
 */
export function approvedAtValid(approvedAt: string | undefined, generatedAt: string): boolean {
  const approved = Date.parse(approvedAt ?? "");
  const generated = Date.parse(generatedAt);
  return Number.isFinite(approved) && Number.isFinite(generated) && approved <= generated;
}

export function approvalNotExpired(expiresAt: string | undefined, generatedAt: string): boolean {
  if (!expiresAt) return true;
  const expiry = Date.parse(expiresAt);
  const generated = Date.parse(generatedAt);
  return Number.isFinite(expiry) && Number.isFinite(generated) && expiry > generated;
}

/** Every `required` entry appears in `supplied` (entries trimmed); empty/absent `supplied` never covers. */
export function coversAll(required: string[], supplied: string[] | undefined): boolean {
  if (!supplied?.length) return false;
  const suppliedSet = new Set(supplied.map((item) => item.trim()));
  return required.every((item) => suppliedSet.has(item));
}
