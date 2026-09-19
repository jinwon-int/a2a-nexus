# Checklist: Jev Recommendation Calibration (Offline Comparison Evaluation, Slice 1)

Refs #2185.

## Spec completeness

- [x] Problem statement ties recommendation-quality measurement to existing recommendation
      surfaces by repo path.
- [x] Non-goals state: no Jev adoption per se, no new routing engine, no replacement of
      #1601/#1597/#1815 scopes, no reuse violation of #885 assets.
- [x] All seven existing assets referenced by repo path as reuse-only:
      `packages/broker/src/core/work-mode-pre-dispatch-decision.ts`,
      `packages/broker/src/core/complexity-orchestration-recommendation.ts`,
      `packages/broker/src/core/scheduler-dry-run.ts`,
      `docs/worker-latency-advisory.md`,
      `packages/broker/src/core/orchestration-intelligence-validation-framework.ts`,
      `packages/broker/src/core/orchestration-intelligence-validation-scorer.ts`,
      `docs/ops/cost-per-outcome.json`.
- [x] Evaluation design pins all five separations: structured judgments; explicit defer vs
      recommendation; probability vs confidence kept distinct; recommendation vs execution
      authority; judgment latency vs task outcome.

## Corpus contract (schema)

- [x] 100–200 initial exploratory records stated as the complete-corpus target; envelope
      capped at 200.
- [x] Judgment-time-only inputs: closed, banded fields; no free text.
- [x] Leakage-preventing: no outcome/verdict/realized-latency/realized-cost/acceptance/success
      property is declared, and `additionalProperties: false` at every level makes any such
      field fail validation.
- [x] Taxonomy covers all seven required types: `simple_fix`, `docs_work`,
      `ambiguous_cause_analysis`, `independent_parallel_work`, `combined_write_scope`,
      `insufficient_information`, `readiness_unmet`.
- [x] Labeling policy encoded: current policy + independent review (`labelStatus`), defer and
      multiple-reasonable answers allowed (`alternativeAcceptable`, `disputed_multiple_reasonable`),
      existing-rule output recorded as data, never ground truth (`existingRuleComparison`).
- [x] Chronological `train`/`calibration`/`holdout` splits with thresholds frozen before
      holdout scoring (protocol rule + frozen threshold ledger requirement).
- [x] Group separation for identical work, retries, and derived cases (`groupKind`,
      `derivedFromRecordId`, same-split rule documented as a protocol invariant).

## Fixture

- [x] 10 fully synthetic public records (≥ 6 required), covering all 7 taxonomy types (≥ 5
      required), all 4 group kinds, all 3 splits.
- [x] Synthetic names only (`jrc-*`, `grp-*`, `reviewer-*-NN`); no real prompts, no internal
      identifiers, no fleet node names, no secrets, no repository names.
- [x] Validates manually against `schemas/corpus-record.schema.json`.

## Validation posture

- [x] No JSON Schema validator exists in the dependency tree (no `ajv` or equivalent in
      `package-lock.json`); no dependencies added; documented manual validation is the
      accepted stance for this slice.
- [x] A deterministic conformance checker is explicitly deferred to a gated follow-up (it
      would be a code change and this slice forbids runtime code and scripts).

## Slice boundary

- [x] Documentation + JSON Schema + synthetic fixture only.
- [x] No runtime code, no scripts (script-surface budget untouched), no package changes, no CI
      changes, no model wiring, nothing enabled.
- [x] Every live-execution/activation/deploy step (G1–G4 in [plan.md](./plan.md) and
      [tasks.md](./tasks.md)) is a separately approvable gate item, default-off.
- [x] No issue completion or closure claim for #2185; finalizer owns review.
