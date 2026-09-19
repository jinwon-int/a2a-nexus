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
- **Independently reviewed development annotations.** Every label is
  `reviewed`, authored as `corpus-author` and attributed to
  `independent-corpus-reviewer-01`. This alias records a separate review
  agent/context, not a claim of a human reviewer or cryptographic identity.
  Review method and limits are described below.
- **The Phase A private calibration/holdout seal is still pending.** This
  file is NOT a blind holdout, NOT calibration data, and NOT a benchmark.
  New private examples require their own independent review and sealing;
  relabeling this exposed file cannot turn it into a blind set.
- **No routing-model benchmark was run.** An A2A implementation worker
  generated these synthetic examples. Their labels are annotations, not
  measured classifier outputs; this file establishes no accuracy or speed result.

The `exposure` field is a caller assertion, not blinding proof: the corpus
format cannot attest that a `private_unexposed` record was truly unseen.
See the spec's corpus slice section for the integrity rules (group/variant
stability, duplicate and leak rejection, exposure gates) enforced before any
digest is produced.

## Independent annotation review for PR #2198

The implementation author initially supplied draft labels with no reviewers.
A separate agent first received only 173 neutral row IDs, language, the closed
input fields, and catalog semantics. Author outcomes, group names and coverage
tags were withheld. Its 173 first-pass judgments were saved before the author
labels were revealed (SHA-256
`15f4dd64d072cb5b21f2947875e42e58837ca0be686bfefb7110f4406a3ec3a9`).
It then compared every one of the 190 author alternatives with its judgments.
The finalizer adjudicated four findings affecting 13 rows:

- Six execution-retry requests now defer as unsupported rather than pretending
  that `resume_existing` (tracking) restarts execution.
- Three vague docs-update rows recommend `docs_patch`; missing implementation
  details alone do not make the requested routing type ambiguous.
- Two same-type, two-PR review requests recommend `review_readonly`; target
  planning remains the assignment layer's responsibility.
- Two explicitly alternative docs requests also accept `docs_analysis` under
  unspecified access; conservative deferral remains an acceptable alternative.

Texts and candidate subsets were retained. Other conservative alternatives
were adjudicated individually; annotations are not a mechanical union of the
first pass and author labels. Multiple accepted outcomes preserve uncertainty.
The final fixture has 192 acceptable alternatives in 173 reviewed records.
Review provenance does not make the labels infallible or these examples unseen.

The 80 groups are topical development scenarios with substantial templating,
bilingual duplication and candidate reuse, not 173 independent observations.
Seven groups vary trusted or candidate inputs across languages, so not every
KO/EN pair is a pure translation-invariance test. Exact normalized-copy checks
cannot establish semantic independence or detect every translated/paraphrased
leak. Separate private grouped calibration/holdout data remains necessary.
