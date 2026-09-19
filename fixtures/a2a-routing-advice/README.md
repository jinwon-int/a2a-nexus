# A2A routing advice fixtures (#2196, offline slices)

Status labels for this directory. Read
[`docs/specs/a2a-routing-classifier/spec.md`](../../docs/specs/a2a-routing-classifier/spec.md)
for the contracts these fixtures illustrate.

## `contracts.json` — illustrative contract cases

27 grouped, explicit valid/invalid cases for the `a2a.routing-input.v1` /
`a2a.routing-advice.v1` advisory contracts (foundation slice 1, merged via
#2197). Executed by `scripts/lib/a2a-routing-advice.test.mjs`.

- **Illustrative only** — contract examples, not training data and not
  evaluation evidence.
- Not the Phase A corpus; the case count must never be presented as
  completing Phase A.

## `development-corpus.json` — public synthetic development corpus

A closed `a2a.routing-corpus.v1` envelope (Phase A corpus-validation slice 2)
validated and digested by `scripts/lib/a2a-routing-corpus.mjs` and executed
whole by `scripts/lib/a2a-routing-corpus.test.mjs`. 80 situation groups,
bilingual Korean/English expression variants per group (160 base records),
plus 13 same-text candidate-subset paired records — 173 records total. The
exact floors (≥ 80 groups, ≥ 160 base variants, ≥ 8 paired groups) are
asserted by the test suite and reported in the body-free coverage summary.

Ground truth about this data — do not misrepresent it:

- **Bilingual corpus.** Every situation group carries at least one Korean and
  one English expression variant; the corpus is intentionally ko/en.
- **Synthetic.** All request texts are invented, human-readable examples.
  No private endpoints, paths, tokens, fleet identifiers, real user chats,
  or production data.
- **Exposed development data only.** Every record is
  `split: development` and `exposure: public_development`. Nothing here has
  been held out from anything.
- **Labels awaiting independent review.** Every `label.status` is `draft`,
  `authorAlias` is `corpus-author`, and `reviewerAliases` is empty. No review
  has been performed or claimed; the acceptable outcomes are author
  declarations only.
- **The Phase A private calibration/holdout seal is still pending.** This
  file is NOT a blind holdout, NOT calibration data, and NOT a benchmark.
  External independent review and sealing are required before any private
  split of this corpus family could support evaluation claims.
- **No routing-model benchmark was run.** An A2A implementation worker
  generated these synthetic examples. Their labels are annotations, not
  measured classifier outputs; this file establishes no accuracy or speed result.

The `exposure` field is a caller assertion, not blinding proof: the corpus
format cannot attest that a `private_unexposed` record was truly unseen.
See the spec's corpus slice section for the integrity rules (group/variant
stability, duplicate and leak rejection, exposure gates) enforced before any
digest is produced.
