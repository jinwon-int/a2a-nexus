# Feature Spec: JEV Probe-Classification Corpus (arms A/B/C evaluation foundation)

> **Status**: spec-first packet for #2206 (follow-up to #2185). Documentation-only:
> this packet adds spec documents, one closed JSON Schema contract, and one fully
> synthetic public fixture. It implements no runtime code, adds no scripts, wires no
> model call, enables no lane or flag, and authorizes no activation, deploy, restart,
> or release. Baseline: main @ `b2d8a92df9d9d59491819a8d025b9d7c670eeefd`. Upstream
> check performed before authoring: no `docs/specs/jev-probe-classification-corpus/`
> directory existed on main at this baseline.

## Problem

The broker's probe-vs-real-work classification is deterministic today (local
heuristics, `a2a-task-handler.mjs`). Issue #2185 planned an offline comparison of
classification arms (A rules / B LLM / C jev) and the landed probe-gating slice
(`docs/specs/jev-probe-gating/`) observes jev verdicts without acting on them — but
neither arm comparison nor any later re-routing decision has a labeled reference
corpus to measure against. Without one, "arm C is as good as arm B and costs four
orders of magnitude less" stays an unprovable claim, and #2196's routing-classifier
work inherits the same gap.

The sibling corpus contract (`docs/specs/jev-recommendation-calibration/`) covers
work-type and processing-method recommendation surfaces with a different taxonomy
(seven recommendation classes). The probe-classification surface needs its own
closed record shape, redaction protocol, and labeling policy — this packet defines
them.

## Goal

One frozen corpus contract for probe-classification records, plus the protocol that
gates any real record from existing until it is ratified:

- **Closed judgment-time input** (`judgmentTimeInput`): banded fields only —
  artifactIds count, payload-file presence, bundle-count band, message word-count
  band, requester class, timing class. No free text, no digests of private text,
  no identities, no paths/URLs, no precise timestamps.
- **Leakage prevention by construction**: the schema declares no outcome, verdict,
  realized-latency, realized-cost, acceptance, or success field, and
  `additionalProperties: false` at every level makes any such field fail validation.
  Outcome joins (did the task succeed downstream?) live outside the corpus and are
  joined only during offline evaluation, never stored in records.
- **Labeling policy**: current-policy computed labels (`policy_computed_review_pending`)
  must obtain independent review (`independently_reviewed`) before use in scoring;
  defer and multiple-reasonable outcomes are terminal label states; the existing
  rule's output is recorded as data (`existingRuleComparison`), never as ground truth.
- **Splits and groups**: chronological `train`/`calibration`/`holdout` splits by
  `observationDate`, with the frozen split boundary recorded in a threshold ledger
  before any holdout scoring; `groupKind` separates identical work, retries, and
  derived cases so independence statistics can exclude them.

## Non-goals

- **No arm selection.** This packet does not pick A, B, or C; it builds the only
  surface on which that comparison can be scored honestly.
- **No runtime code, no scripts** (the repo enforces a script-surface budget), no
  package changes, no CI changes, no model calls, nothing enabled.
- **No real-traffic records in the repository.** Until the redaction protocol below
  is ratified and collection begins under it, every committed record is synthetic.
- **No re-routing, dispatch, or gate change.** The probe-gating slice's observe-only
  contract and the 6-key probe-ack contract are untouched.
- **No replacement of #1601/#1597/#1815/#885 scopes**; the calibration corpus
  contract for recommendation surfaces (`docs/specs/jev-recommendation-calibration/`)
  is reused as a pattern, not modified.

## Record contract (v1, frozen by `schemas/probe-corpus-record.schema.json`)

| Field | Type / values |
| --- | --- |
| `recordId` | `jpc-NNNN` (synthetic naming; no real ids) |
| `observationDate` | date granularity only (`YYYY-MM-DD`) |
| `source` | `synthetic` \| `local_shadow` \| `broker_observed` |
| `groupKind` | `unique` \| `identical_work` \| `retry` \| `derived_case` |
| `split` | `train` \| `calibration` \| `holdout` |
| `derivedFromRecordId` | optional `jpc-NNNN` (for `derived_case`) |
| `judgmentTimeInput.artifactIdsCount` | integer 0–99 |
| `judgmentTimeInput.payloadFilePresent` | boolean |
| `judgmentTimeInput.bundleFilesBand` | `none` \| `1` \| `2-5` \| `6+` |
| `judgmentTimeInput.messageWordsBand` | `0-3` \| `4-20` \| `21-100` \| `100+` |
| `judgmentTimeInput.requesterClass` | `pipeline_health` \| `agent` \| `operator` \| `unknown` |
| `judgmentTimeInput.timingClass` | `recurring_identical` \| `post_restart` \| `one_off` |
| `label.labelStatus` | `policy_computed_review_pending` \| `independently_reviewed` \| `disputed_multiple_reasonable` \| `unlabeled_pending_policy` |
| `label.policyVersion` | string (frozen policy identity, e.g. skill criteria + date) |
| `label.class` | `probe` \| `incomplete` \| `proceed` \| `defer` |
| `label.alternativeAcceptable` | boolean (another class is arguably correct) |
| `label.existingRuleComparison` | optional closed object: `{ ruleVersion, class }` — data, never ground truth |

Schema rules: `additionalProperties: false` at every level; envelope capped at 200
records (exploratory-corpus size, matching the calibration precedent); the word
"outcome" appears in no declared property name or enum.

## Redaction protocol (must be ratified before any real record exists)

1. Banded fields only, exactly as the schema enumerates. No free text anywhere in a
   record; no digests, encodings, or hashes of private text; no identities, node
   names, repository names, paths, URLs, or credentials.
2. Timestamps at date granularity only (`observationDate`); no times of day.
3. Judgment-time-only capture: a record is written from dispatch-time information
   exclusively, and outcome channels are structurally unable to append to it
   (enforced by the closed schema).
4. Every real record stays outside the repository until this protocol is ratified;
   ratification is recorded in the tracking issue (#2206).

## Labeling policy

- The reference policy is the deterministic classification embodied by the
  `a2a-incomplete-task-handler` skill criteria (probe / incomplete / proceed with
  ambiguous-to-incomplete tie-breaking), frozen as `label.policyVersion`.
- jev's own verdict is never a label: it is one of the arms being evaluated.
- Independent review uses opaque reviewer aliases; review coverage is recorded per
  record via `label.labelStatus`.
- Existing-rule output is captured in `existingRuleComparison` as comparison data.

## Evaluation posture (downstream slices, not this packet)

- Offline comparison runs on `train` + `calibration` only; holdout is one-shot after
  thresholds are frozen in a ledger; identical-work/retry groups are excluded from
  independence statistics (calibration-spec pattern, Phase 3–5 shapes).
- Metrics: per-class agreement, defer rate, probability calibration
  (Brier/ECE on arm-C probabilities vs arm labels), confidence/probability
  separation, per-requesterClass breakdown.

## Reuse contract (decided)

| Asset | Role in this packet |
| --- | --- |
| `docs/specs/jev-recommendation-calibration/` | Pattern for closed-schema corpus, leakage rule, split/group discipline, fixture conventions. Read-only reuse. |
| `docs/specs/jev-probe-gating/` | The classification surface being measured; its observe-only contract is untouched. |
| `a2a-incomplete-task-handler` skill criteria | Reference labeling policy (frozen by `policyVersion` at labeling time). |
| `docs/specs/a2a-routing-classifier/` | #2196's classifier lanes are future consumers of the same corpus. |

## Refs

- #2206 (this packet's tracking issue), #2185 (spec-first ancestor, closed),
  #2196 (routing classifier consumer), `docs/specs/jev-probe-gating/`,
  `docs/specs/jev-recommendation-calibration/`.
