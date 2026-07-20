/**
 * Canonical JSON + hash primitives for the bounded PR review lifecycle (#1518).
 *
 * TypeScript port of the Phase-1 reference at
 * test/conformance/lib/canonical-json.mjs. The rules are identical and the
 * golden vectors pinned in test/conformance/check-bounded-pr-review-lifecycle.mjs
 * MUST stay green against this port (parity is locked by
 * review-lifecycle/canonical-json.test.ts).
 *
 * - intentHash: SHA-256 over canonical JSON (sorted keys, UTF-8, no
 *   insignificant whitespace) of every IntentContractV1 field except
 *   createdAt and intentHash.
 * - diffHash: SHA-256 over canonical patch bytes
 *   (`git diff --no-color --no-ext-diff --no-renames --unified=3 <base> <head>`).
 *   Commit metadata is not an input, so metadata-only HEAD changes leave
 *   diffHash unchanged (clarify Q2).
 */

import { createHash } from "node:crypto";

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalize(item)).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalize(record[key])).join(",") + "}";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const INTENT_HASH_EXCLUDED_FIELDS: readonly string[] = Object.freeze(["createdAt", "intentHash"]);

export function intentHashPayload(contract: Record<string, unknown>): Record<string, unknown> {
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) {
    throw new TypeError("intent contract must be an object");
  }
  const entries = Object.entries(contract).filter(([key]) => !INTENT_HASH_EXCLUDED_FIELDS.includes(key));
  return Object.fromEntries(entries);
}

export function intentHash(contract: Record<string, unknown>): string {
  return "sha256:" + sha256Hex(canonicalize(intentHashPayload(contract)));
}

export function diffHash(patchText: string): string {
  if (typeof patchText !== "string") {
    throw new TypeError("diffHash input must be canonical patch text");
  }
  return "sha256:" + sha256Hex(patchText);
}

/** SHA-256 of the empty string: an empty diff (metadata-only HEAD change). */
export const EMPTY_DIFF_HASH = diffHash("");

export function findingSignature(input: { criterionRef: string; category: string; evidenceRefs: string[] }): string {
  const normalizedEvidence = [...input.evidenceRefs].map((ref) => String(ref).trim()).filter(Boolean).sort();
  return "sha256:" + sha256Hex(canonicalize({ category: input.category, criterionRef: input.criterionRef, evidenceRefs: normalizedEvidence }));
}
