# Plan: Jev Recommendation Calibration (Offline Comparison Evaluation, Slice 1)

Refs #2185. See [the spec](./spec.md). Baseline: main @
`d622d7db4e1be032d6310c0a93f51de4d8655599`.

## Phase 0 — Spec packet (this slice)

- [x] Author spec, plan, tasks, checklist.
- [x] Freeze the closed judgment-time input surface and the leakage rule as JSON Schema
      (`schemas/corpus-record.schema.json`).
- [x] Freeze the record taxonomy, label axes, split/group semantics, and labeling policy.
- [x] Add one fully synthetic public fixture covering all seven taxonomy types
      (`fixtures/jev-recommendation-calibration/corpus-sample.json`).
- [x] Add no runtime code, no scripts, no packages, no CI changes, no model wiring; enable
      nothing.

Exit gate: documents internally consistent; schema and fixture in place; no runtime surface
touched.

## Phase 1 — Corpus collection and redaction protocol (separate slice, not approved here)

- [ ] Ratify the redaction protocol before any real record exists: no free-form text, no
      digests of private text, no identities, no paths/URLs, no precise timestamps, no
      credentials; date-granularity timestamps only.
- [ ] Ratify the judgment-time-only capture rule: a record is written from dispatch-time
      information exclusively; outcome channels are structurally unable to append to it.
- [ ] Collect 100–200 initial exploratory records into the closed record shape.
- [ ] Assign groups (`unique` / `identical_work` / `retry` / `derived_case`) at capture time.
- [ ] Assign chronological `train` / `calibration` / `holdout` splits by `observationDate`;
      record the frozen split boundary dates in a threshold ledger **before** holdout scoring.

Exit gate: corpus file validates against the frozen schema; redaction review signed off;
threshold ledger committed before any holdout record is scored.

## Phase 2 — Labeling protocol (separate slice, not approved here)

- [ ] Compute policy labels (`labelStatus: policy_computed_review_pending`) with the frozen
      policy version.
- [ ] Obtain independent review per record (opaque reviewer aliases only); record
      `independently_reviewed` or `disputed_multiple_reasonable`.
- [ ] Allow defer and multiple-reasonable answers as terminal label states; treat
      existing-rule output as data (`existingRuleComparison`), never as ground truth.
- [ ] Freeze the label ledger; no label may change after holdout scoring begins.

Exit gate: label ledger frozen; review coverage recorded; no outcome field present anywhere.

## Phase 3 — Evaluation harness reuse (separate slice, not approved here)

- [ ] Reuse the packet/metric shapes of
      `packages/broker/src/core/orchestration-intelligence-validation-framework.ts` (metric
      name, unit, direction, required) for comparison reports instead of inventing a format.
- [ ] Reuse the decision-status semantics of
      `packages/broker/src/core/orchestration-intelligence-validation-scorer.ts`
      (e.g., `blocked`, `waiting_for_paired_evidence`) for comparison verdicts.
- [ ] Run in-process and offline only; no broker code changes, no new root scripts (script
      budget untouched); any checker registers in the existing `test/conformance/` runner.

Exit gate: harness reads corpus and ledger files only; no network, no model calls.

## Phase 4 — Offline comparison protocol (separate slice, not approved here)

- [ ] Compare current-policy baseline vs candidate policy/prompt variants on **train +
      calibration only**; holdout is untouched.
- [ ] Report per-axis agreement, defer rate, probability calibration (e.g., Brier/ECE on
      `probability`), confidence/probability separation checks, and per-taxonomy breakdowns;
      identical-work and retry groups are excluded from independence statistics.
- [ ] Freeze candidate selection and all acceptance thresholds in the threshold ledger.

Exit gate: no holdout record read; threshold ledger updated with candidate + thresholds.

## Phase 5 — Holdout evaluation (separate slice, not approved here)

- [ ] One-shot scoring of the holdout split with frozen thresholds; results are final and not
      iterated.
- [ ] Any holdout-triggered revision restarts the protocol at Phase 4 with a new holdout
      window; the used holdout is retired.

Exit gate: single holdout report; no tuning loop observed.

## Phase 6 — Outcome join, end-to-end view (separate slice, not approved here)

- [ ] Join holdout outcomes with `docs/ops/cost-per-outcome.json` on anonymous axes only, and
      latency views with `docs/worker-latency-advisory.md` framing — outcome and latency stay
      on separate planes and never re-enter corpus inputs.

Exit gate: join is read-only, anonymous-axis, and published as an evaluation artifact.

## Phase 7 — Activation gates (each separately approvable, each default-off)

None of these is authorized by this packet. Each requires its own scoped change and explicit
approval, and stays default-off until individually approved:

- [ ] **G1 — model wiring:** any judge/model call used to produce labels or comparisons.
- [ ] **G2 — runtime read:** any broker runtime read of corpus, labels, or comparison output.
- [ ] **G3 — policy adoption:** changing any live recommendation behavior based on results.
- [ ] **G4 — deploy:** any activation, restart, release, or config change connected to this
      evaluation.

Explicitly deferred and not approved: everything in Phases 1–7. Completion or closure of
#2185 is not claimed by this slice.
