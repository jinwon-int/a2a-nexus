// Reference canonicalization and hash primitives for the bounded PR review
// lifecycle (#1518 Phase 1). This module is the Phase-1 reference used by the
// conformance vectors; the Phase-3 broker record-mode integration ports the
// same rules to packages/broker and MUST keep these vectors green.
//
// Rules (docs/specs/bounded-pr-review-lifecycle/spec.md + clarify.md):
// - intentHash: SHA-256 over the canonical JSON serialization (sorted keys,
//   UTF-8, no insignificant whitespace) of every IntentContractV1 field except
//   createdAt and intentHash. Serialization-only normalization: rewording the
//   intent changes the hash by design.
// - diffHash: SHA-256 over the canonical patch bytes produced by
//   `git diff --no-color --no-ext-diff --no-renames --unified=3 <base> <head>`.
//   Rename detection is disabled (delete+add) so the value is stable across
//   git versions and rename heuristics. Commit metadata is not an input, so
//   metadata-only HEAD changes leave diffHash unchanged (clarify Q2).

import { createHash } from 'node:crypto';

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalize(item)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export const INTENT_HASH_EXCLUDED_FIELDS = Object.freeze(['createdAt', 'intentHash']);

export function intentHashPayload(contract) {
  if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new TypeError('intent contract must be an object');
  }
  const entries = Object.entries(contract).filter(([key]) => !INTENT_HASH_EXCLUDED_FIELDS.includes(key));
  return Object.fromEntries(entries);
}

export function intentHash(contract) {
  return 'sha256:' + sha256Hex(canonicalize(intentHashPayload(contract)));
}

export function diffHash(patchText) {
  if (typeof patchText !== 'string') {
    throw new TypeError('diffHash input must be canonical patch text');
  }
  return 'sha256:' + sha256Hex(patchText);
}

// SHA-256 of the empty string: an empty diff (metadata-only HEAD change)
// hashes to this constant.
export const EMPTY_DIFF_HASH = diffHash('');

export function findingSignature({ criterionRef, category, evidenceRefs }) {
  const normalizedEvidence = [...evidenceRefs].map((ref) => String(ref).trim()).filter(Boolean).sort();
  return 'sha256:' + sha256Hex(canonicalize({ category, criterionRef, evidenceRefs: normalizedEvidence }));
}
