# Complete bounded analysis review notes

Issue: #2130. Size: Medium (worker result contract).

The handler currently slices a selected review note to 1,000 UTF-16 code units.
This can remove whole per-item records or cut their JSON before attestation.
A reviewer needs the downstream verifier to receive the complete selected note.

## Contract

- Preserve the selected note after the existing outer-whitespace normalization.
  Keep existing field precedence, verdict parsing, reviewer identity, and
  missing-evidence behavior. Never invent a verdict or join unrelated fields.
- Accept at most 65,536 UTF-8 bytes, inclusive. This admits ten bounded item
  records with 2,000 Korean characters of rationale each plus record metadata
  (about 63 KiB), while retaining a finite per-note limit. This is not a promise
  that arbitrary batches fit; oversized batches must be redesigned explicitly.
- Above that limit, return `review_note_too_large` with numeric byte counts only.
  Do not truncate, fall back to a shorter field, emit a successful result, or
  post a handler-owned completion comment. Existing earlier bridge/provider
  effects cannot be undone by this check.
- Apply this to both bridge and builtin structured analysis paths. Non-review
  tasks retain their existing behavior.
- The existing Piri schema accepts a `summary` string and explicit `verdict`.
  Full structured records can use that carrier. `review.note` is not a field
  in that schema; this change does not add one or change adapter schemas.

## Verification and boundaries

Use synthetic bridge responses through the real Piri normalizer and handler,
including four record lines beyond the old limit, exact byte boundaries,
multibyte text, explicit field precedence, negative verdicts, both execution
paths, and missing/non-review behavior. Demonstrate old failure/new success.
A separate reviewer verifies the frozen commit and concrete failure paths;
at most one fix re-review is permitted.

No live provider sends, runtime deployments/restarts, database changes, secret
movement, or clinical approval. A subsequent worker rollout requires specific
operator approval and actual runtime qualification before formal content review.
Source tests do not constitute signed clinical evidence.
