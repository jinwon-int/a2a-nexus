# Tasks: Jev Recommendation Calibration (Offline Comparison Evaluation, Slice 1)

Refs #2185.

## This documentation-only slice

- [x] Verify `docs/specs/jev-recommendation-calibration/` did not exist upstream at baseline
      `d622d7db4e1be032d6310c0a93f51de4d8655599`.
- [x] Write problem statement, non-goals (no Jev adoption, no new routing engine, no
      #1601/#1597/#1815 replacement, no #885 asset reuse violation), and the five-separation
      evaluation design in [spec.md](./spec.md).
- [x] Reference all seven existing assets by repo path, reuse-only.
- [x] Encode the corpus contract (100–200 records, judgment-time-only inputs, seven-type
      taxonomy, labeling policy, chronological splits with pre-holdout frozen thresholds,
      group separation) in [schemas/corpus-record.schema.json](./schemas/corpus-record.schema.json).
- [x] Make the schema leakage-preventing: closed surfaces (`additionalProperties: false` at
      every level) declare no outcome/verdict/realized-latency/realized-cost/acceptance field.
- [x] Add `fixtures/jev-recommendation-calibration/corpus-sample.json`: 10 fully synthetic
      public records covering all 7 taxonomy types, 4 group kinds, all 3 splits, defer labels,
      disputed/multiple-reasonable labels, and all 3 `existingRuleComparison` values.
- [x] Validate the fixture manually against the schema (no JSON Schema validator exists in the
      dependency tree; no dependencies or scripts added).
- [x] Confirm no internal fleet node names and no real identifiers in any committed file.
- [x] Add no runtime code, no scripts, no package changes, no CI changes; wire no model calls;
      enable nothing.

## Phased follow-ups (all require separate scoped changes)

- [ ] Phase 1 — corpus collection and redaction protocol (see [plan.md](./plan.md)).
- [ ] Phase 2 — labeling protocol: current policy + independent review; defer and
      multiple-reasonable allowed; existing-rule output is not ground truth.
- [ ] Phase 3 — evaluation harness reusing the existing orchestration-intelligence validation
      framework and scorer packet shapes.
- [ ] Phase 4 — offline comparison on train + calibration only.
- [ ] Phase 5 — one-shot holdout evaluation under thresholds frozen before holdout.
- [ ] Phase 6 — read-only end-to-end outcome join on anonymous axes.

## Activation gates (default-off; each separately approvable)

- [ ] **G1** — wire any judge/model call for label production or comparison.
- [ ] **G2** — any broker runtime read of corpus, labels, or comparison output.
- [ ] **G3** — change any live recommendation policy based on results.
- [ ] **G4** — any activation, deploy, restart, release, or config change tied to this
      evaluation.

## Explicitly out of scope

- [ ] Jev adoption into runtime.
- [ ] A new routing engine.
- [ ] Absorbing or completing #1601, #1597, or #1815.
- [ ] Modifying any #885 asset (all referenced by path, reuse-only).
- [ ] Completing or closing #2185.
