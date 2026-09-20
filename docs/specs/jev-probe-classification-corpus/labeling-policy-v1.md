# Labeling policy v1 — `probe-handling-policy@2026-09-21`

Refs #2206. Frozen policy identity for Phase-2 labeling of
[corpus-exploratory-v1.json](./corpus-exploratory-v1.json). The normative basis is
the deterministic classification embodied by the `a2a-incomplete-task-handler`
skill criteria (probe / incomplete / proceed with ambiguous-to-incomplete
tie-breaking), per [spec.md](./spec.md) "Labeling policy".

This document records the frozen decision table and the application report for
the initial exploratory corpus. It grants no runtime authority; labels are
evaluation data.

## Decision table (priority order, total over the closed input surface)

Evaluated strictly on `judgmentTimeInput` in the order below. The first match
wins; unmatched records fall through to rule 3 (the tie-break).

1. **probe** — the full health-check signature, all signals aligned:

   `requesterClass = pipeline_health` AND `payloadFilePresent = false` AND
   `bundleFilesBand = none` AND `messageWordsBand = 0-3` AND
   `timingClass ∈ {recurring_identical, post_restart}`

   → `class = probe`, `alternativeAcceptable = false`.

2. **proceed** — full evidence: indexed targets plus attached material:

   `artifactIdsCount ≥ 1` AND `payloadFilePresent = true` AND
   `bundleFilesBand ≠ none`

   → `class = proceed`, `alternativeAcceptable = false`.

3. **incomplete** — everything else (ambiguous-to-incomplete tie-break:
   block, never fabricate):

   → `class = incomplete`, with `alternativeAcceptable = true` when material
   evidence exists despite the gap (`bundleFilesBand ≠ none` OR
   `artifactIdsCount ≥ 1`) — i.e. a reasonable reviewer could argue proceed —
   and `alternativeAcceptable = false` otherwise.

`defer` is not a policy output; it appears only as the class placeholder of
`unlabeled_pending_policy` records and as a terminal state of independent
review. The policy's tie-break resolves every input, so rule 3 is a total
fallback.

## Anchor verification

All eight labeled fixture records in
`fixtures/jev-probe-classification-corpus/corpus-sample.json` (both
`policy_computed_review_pending` and `independently_reviewed` examples)
reproduce exactly under this table, including `alternativeAcceptable`
semantics on the partial-evidence case (`jpc-0006`: incomplete,
alternative-acceptable). The two `unlabeled_pending_policy` fixture records
are placeholders and have no policy output to reproduce.

## Application report — corpus-exploratory-v1.json (156 records)

- 156/156 records labeled `policy_computed_review_pending` under
  `probe-handling-policy@2026-09-21`; no record left unlabeled.
- Distribution: `incomplete` 156 (`alternativeAcceptable = true` 146,
  `alternativeAcceptable = false` 10); `probe` 0; `proceed` 0.
- Degeneracy is a capture-window fact, not a policy choice, and is recorded
  honestly: every retained record has `artifactIdsCount = 0` and
  `payloadFilePresent = true`, and the window contains no `pipeline_health`
  requester, so rule 1 never fires (the known Phase-1 gap — the probe class is
  covered by the synthetic sample until real probe traffic is captured) and
  rule 2 never fires (no indexed artifacts in the window). Rule 2's
  alternative-acceptability flag still separates the 146 records with bundle
  material in the payload (proceed arguable) from the 10 without.
- Existing-rule output is deliberately not embedded here:
  `existingRuleComparison` is Arm-A data collected in Phase 3.

## Independence posture

These labels are policy-computed and review-pending. Per
[plan.md](./plan.md) Phase 2, per-record independent review (opaque reviewer
aliases; terminal states `independently_reviewed` or
`disputed_multiple_reasonable`; defer allowed) must complete before any
scoring use, and the label ledger freezes only after that review. The
computing party does not self-certify sufficiency or applicability of this
labeling.
