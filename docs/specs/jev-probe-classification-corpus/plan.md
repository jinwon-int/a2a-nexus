# Plan: JEV Probe-Classification Corpus (spec-first packet)

Refs #2206. See [the spec](./spec.md). Baseline: main @
`b2d8a92df9d9d59491819a8d025b9d7c670eeefd`.

## Phase 0 — Spec packet (this slice)

- [x] Author spec, plan, tasks.
- [x] Freeze the closed judgment-time input surface and the leakage rule as JSON
      Schema (`schemas/probe-corpus-record.schema.json`).
- [x] Freeze the class taxonomy, label axes, split/group semantics, and labeling
      policy (spec.md "Record contract" and "Labeling policy").
- [x] Add one fully synthetic public fixture covering all three classes, all four
      group kinds, all three splits, and all four label statuses
      (`fixtures/jev-probe-classification-corpus/corpus-sample.json`).
- [x] Add no runtime code, no scripts, no packages, no CI changes, no model wiring;
      enable nothing.

Exit gate: documents internally consistent; schema and fixture in place and
schema-validating; no runtime surface touched.

## Phase 1 — Corpus collection under the ratified redaction protocol (separate slice)

- [ ] Record redaction-protocol ratification in #2206 before any real record is
      committed anywhere.
- [ ] Capture records from dispatch-time information only, in the closed shape;
      real records stay operator-local until capture is reviewed.
- [ ] Collect 100–200 initial exploratory records; assign `groupKind` at capture
      time; assign chronological splits by `observationDate`.
- [ ] Freeze split boundary dates in a threshold ledger **before** holdout scoring.

Exit gate: corpus validates against the frozen schema; ratification recorded;
threshold ledger committed before any holdout record is scored.

## Phase 2 — Labeling (separate slice)

- [x] Compute policy labels with the frozen `policyVersion`
      (`policy_computed_review_pending`) — done for the 156 exploratory records;
      frozen decision table and application report in
      [labeling-policy-v1.md](./labeling-policy-v1.md).
- [x] Independent review per record under opaque reviewer aliases; terminal states
      `independently_reviewed` or `disputed_multiple_reasonable`; defer allowed —
      done: 156/156 `independently_reviewed` (0 disputed, 0 defer) via
      independent broker-backed worker review; coverage, evidence grades, and
      reviewer findings in [review-ledger-v1.json](./review-ledger-v1.json).
- [x] Freeze the label ledger; no label changes after holdout scoring begins —
      frozen 2026-09-21 (`labelLedger.frozenAt` in review-ledger-v1.json).

Exit gate: label ledger frozen; review coverage recorded; no outcome field present.

## Phase 3 — Arms A/B/C offline comparison (separate slice)

- [x] Arm A: existing deterministic rules (baseline, recorded as data) —
      handler-heuristics@2026-09-21 executed locally; outputs in
      [arm-results-v1.json](./arm-results-v1.json).
- [x] Arm B: LLM classification under the fleet's model-cost accounting —
      broker-backed analysis worker (source-only, no-live); token usage and
      bridge-reported cost recorded per arm in the results file.
- [x] Arm C: jev classification via the landed typed facade — facade-equivalent
      single-attempt contract executed through the fleet jev client on the
      pilot node against the same closed banded surface; noul probabilities
      recorded for calibration.
- [x] Score on `train` + `calibration` only: per-class agreement, defer rate,
      calibration (Brier/ECE), per-requesterClass breakdown; exclude
      identical-work/retry groups from independence statistics — all metrics
      in arm-results-v1.json; holdout not read.
- [x] Freeze candidate selection + thresholds in the threshold ledger —
      candidate: keep the existing deterministic rule; arm-C act threshold
      0.80 (pre-frozen) recorded for any future adoption; interpretive
      caveats recorded (`arms.candidate` in threshold-ledger.json).

Exit gate: no holdout record read; ledger updated with candidate + thresholds.

## Phase 4 — Holdout (separate slice)

- [ ] One-shot holdout scoring with frozen thresholds; results are final.
- [ ] Any holdout-triggered revision restarts Phase 3 with a new holdout window.

Exit gate: single holdout report; no tuning loop observed.

## Explicitly NOT done (re-asserted)

- No runtime authority anywhere: corpus records never gate claims, dispatch,
  retries, or routing.
- No real-traffic records committed in this packet.
- No jev adoption claim: arm selection is a Phase 3 outcome, and "keep the existing
  rule" is an allowed conclusion.
