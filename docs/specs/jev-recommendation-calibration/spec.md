# Feature Spec: Jev Recommendation Calibration (Offline Comparison Evaluation, Slice 1)

> **Status:** spec-first packet for #2185 (first slice only). Documentation-only: this packet
> adds spec documents, one JSON Schema corpus contract, and one synthetic public fixture. It
> does not implement runtime code, add scripts, wire any model call, enable any lane or flag,
> or authorize any activation, deploy, restart, or release. Baseline: main @
> `d622d7db4e1be032d6310c0a93f51de4d8655599`. Upstream check performed before authoring: no
> `docs/specs/jev-recommendation-calibration/` directory existed on main at this baseline.

## Problem

The broker already produces work-type and processing-method style recommendations — work-mode
pre-dispatch decisions, complexity/orchestration recommendations, and scheduler dry-run
readouts — but their *quality* has never been measured offline against a fixed, leakage-free
reference. Recommendation policy changes are currently judged anecdotally: there is no corpus
of judgment-time-only inputs, no labeled reference answers that admit defer and
multiple-reasonable outcomes, no chronological train/calibration/holdout separation, and no
comparison protocol that prevents accidental tuning on the data used to score. Downstream
documents (`docs/worker-latency-advisory.md`, `docs/ops/cost-per-outcome.json`) describe
realized effects, but neither isolates whether the *recommendation itself* was right at
judgment time.

This slice therefore authors the spec packet for an offline comparison evaluation of
work-type and processing-method recommendations. The benchmarking structure is deliberately
inspired by five practices:

| Practice | How it appears in this design |
| --- | --- |
| Small structured judgments | Judgment-time inputs are reduced to closed, banded fields; each record is one small structured question, not a free-form essay |
| Uncertainty display | Every label carries both a probability and a separate confidence band, displayed side by side and never merged |
| Parallel independent questions | Records are judged independently; corpus and group-separation rules forbid cross-record contamination, so questions can be asked in parallel without order effects |
| Code-combined judgments | The `combined_write_scope` taxonomy type and `combined_write` work-type label make combined multi-surface write judgments a first-class question |
| End-to-end outcome evaluation | A separate holdout and outcome-join stage scores whether recommendations correspond to end-to-end outcomes, using the existing validation-framework/scorer packet patterns and the cost-per-outcome ledger on anonymous axes |

## Non-goals

- **No Jev adoption per se.** This packet evaluates recommendation *calibration* offline. It
  does not adopt, endorse, wire, or enable any external evaluation framework or toolchain
  ("Jev" included) into broker runtime.
- **No new routing engine.** Nothing here computes, stores, or serves recommendations. Existing
  engines keep their behavior; this packet only defines how their *quality* would be measured.
- **No replacement of #1601 / #1597 / #1815 scopes.** Those lanes own their own slices. This
  packet does not absorb, redefine, or complete them.
- **No reuse violation of #885 assets.** Existing assets are referenced by repo path below and
  are *reused read-only as evaluation-harness patterns and reference surfaces*. Nothing in this
  packet modifies them, copies them into a new surface, or re-licenses their scope.
- No runtime code, no scripts (the repo enforces a script-surface budget), no package changes,
  no CI changes, no model calls, and nothing enabled.
- No collection of real task content. The only artifact in this slice is a synthetic public
  fixture; the future corpus protocol (Phase 1 of plan.md) must re-approve redaction before
  any real record exists.

## Existing assets referenced (reuse-only, by repo path)

| Asset | Role in this evaluation |
| --- | --- |
| `packages/broker/src/core/work-mode-pre-dispatch-decision.ts` | Existing recommendation surface whose output vocabulary motivates the work-type/processing-method label axes; read as a reference, never modified or invoked by this slice |
| `packages/broker/src/core/complexity-orchestration-recommendation.ts` | Existing complexity/orchestration recommendation logic; source of the existing-rule baseline to compare against (`existingRuleComparison` field), never modified |
| `packages/broker/src/core/scheduler-dry-run.ts` | Existing dry-run readout; motivates the `dry_run_first` processing-method label and the readiness signals, never modified |
| `docs/worker-latency-advisory.md` | Prior art for latency advisory framing; motivates the strict separation between judgment latency and task outcome, never modified |
| `packages/broker/src/core/orchestration-intelligence-validation-framework.ts` | Existing evidence-packet framework; the planned offline harness reuses its packet/metric shapes (unit, direction, required) rather than inventing a new one |
| `packages/broker/src/core/orchestration-intelligence-validation-scorer.ts` | Existing scorer packet patterns (per-scenario decision statuses such as `blocked`/`waiting_for_paired_evidence`); planned comparison reports reuse these semantics |
| `docs/ops/cost-per-outcome.json` | Existing normalized cost-per-accepted-outcome ledger; the future outcome-join stage joins on anonymous axes only, exactly as that file's own contract requires |

## Calibration evaluation design

Five separations are load-bearing. Each is a contract rule, not a suggestion.

1. **Structured judgments.** A record's judgment-time input is a closed, banded object
   (`judgmentTimeInput` in the schema): request class, diff-size band, file-scope band, write
   surface, ambiguity signals, parallelizability signal, readiness signal. No free text, no
   prompts, no payloads. If a judgment cannot be made from the bands, the honest label is
   `defer` / `insufficient_information`, not a guess encoded as a precise answer.
2. **Explicit defer vs recommendation.** `defer` is a first-class value on both label axes
   (`workType: "defer"`, `processingMethod: "defer_to_operator"`). Defer is never derived from
   low confidence and never reported as a recommendation with a confidence value; they are
   different answers to different questions.
3. **Probability vs confidence semantics kept distinct.** `probability` is an elicited,
   protocol-bound number in `[0,1]` — the probability that the labeled work type is an
   acceptable answer given the judgment-time input. `confidenceBand` (`low`/`medium`/`high`)
   is the judge's self-reported confidence in its own reasoning quality. The schema keeps them
   as separate fields; comparison metrics must score calibration on `probability` and may only
   *describe* `confidenceBand`. Merging them (e.g., "confidence 0.55") is a contract violation.
4. **Recommendation vs execution authority separation.** Labels, recommendations, and
   comparison reports are evaluation artifacts. They grant no dispatch authority, do not gate
   claims, retries, finalization, or merges, and are never read by broker runtime. Any future
   runtime read is a separately approved gate item, default-off (see plan.md Phase 7).
5. **Judgment latency vs task outcome separation.** How long a judge took to answer and what
   eventually happened to the task are two different measurements on two different planes.
   Neither may be stored in the corpus record's input surface (the schema forbids it), latency
   must never be used as an outcome proxy, and outcomes must never be back-filled into
   judgment-time inputs. Outcome joins happen only in the separate holdout/outcome stage.

## Corpus contract

- **Size:** 100–200 initial exploratory records for a complete corpus submission. The sample
  fixture in this slice is a 10-record excerpt and is exempt from the minimum as an example.
- **Leakage-preventing inputs.** Inputs are restricted to information available at judgment
  time. The schema's closed surface (`additionalProperties: false` at every level) declares no
  outcome, verdict, review-outcome, realized-latency, realized-cost, acceptance, or success
  field, so any such field fails validation fail-closed.
- **Record type taxonomy.** Every record declares exactly one `taxonomyType`:
  `simple_fix`, `docs_work`, `ambiguous_cause_analysis`, `independent_parallel_work`,
  `combined_write_scope`, `insufficient_information`, `readiness_unmet`.
- **Labeling policy.**
  - Labels are fixed by the current policy computation **plus** independent review; a
    policy-only label carries `labelStatus: "policy_computed_review_pending"`.
  - Multiple reasonable answers are allowed: `alternativeAcceptable: true`, and
    `labelStatus: "disputed_multiple_reasonable"` records the dispute honestly.
  - Defer is always an allowed label.
  - Existing-rule output is **not** automatically ground truth: the
    `existingRuleComparison` field records agreement or disagreement as data, and an
    `existing_rule_agreed` value confers no extra correctness.
- **Chronological splits.** Each record carries `observationDate` and exactly one
  `chronologicalSplit` (`train`, `calibration`, `holdout`). Split assignment is chronological:
  every train record precedes every calibration record, which precedes every holdout record.
  Thresholds (split boundary dates, calibration score cutoffs, and any acceptance thresholds)
  are frozen and recorded before any holdout record is scored; no threshold may be revised
  after a holdout score is produced.
- **Group separation.** Every record has a `group`:
  - `groupKind: "unique"` — standalone case;
  - `groupKind: "identical_work"` — byte-equivalent work judged twice; both members must land
    in the same split;
  - `groupKind: "retry"` — retry attempts of one root; all members stay in one split;
  - `groupKind: "derived_case"` — a case derived from an earlier record (declared via
    `derivedFromRecordId`); derived records belong to the split their `observationDate` falls
    in, and the derivation edge is declared so outcome-join analysis can exclude them.
  - Records sharing a `groupId` must never straddle splits; identical-work and retry groups
    are excluded from "parallel independent question" scoring so agreement by construction
    cannot inflate independence claims.
- **Protocol-only invariants** (not expressible in single-record JSON Schema, checked during
  corpus review): `ambiguitySignals` containing `none_reported` must contain no other signal;
  all records sharing a `groupId` share one `chronologicalSplit`; `observationDate` must fall
  inside the frozen window of the declared split.

## Label axes

Label vocabularies are evaluation-side closed enums, deliberately **not** broker runtime
enums. Translation into any runtime vocabulary is a gate-gated future step.

| Axis | Values |
| --- | --- |
| `workType` | `bug_fix`, `docs_update`, `cause_analysis`, `parallel_independent`, `combined_write`, `defer` |
| `processingMethod` | `single_worker_sequential`, `parallel_workers`, `team1_orchestration`, `dry_run_first`, `defer_to_operator` |

## Privacy and synthetic content rules

- Fixture content is fully synthetic: synthetic record/group/reviewer aliases only
  (`worker-alpha`-style), no real prompts, no internal identifiers, no fleet node names, no
  secrets, no repository names, no timestamps finer than a calendar date.
- A future real corpus must pass a redaction protocol (plan.md Phase 1) before any record is
  written: no free-form text, no digests of private text, no identities, no paths or URLs, no
  precise timestamps, no credentials.
- Committed files must not contain internal fleet node names.

## Validation and conformance stance

- There is no JSON Schema validator in the repository dependency tree (no `ajv` or equivalent
  in `package-lock.json`), and this slice adds no dependencies and no scripts. The sample
  fixture is therefore validated **manually** against
  `docs/specs/jev-recommendation-calibration/schemas/corpus-record.schema.json` (closed
  surfaces, enums, patterns, bounds, and cross-level `$ref`s were checked by hand for every
  record).
- A deterministic checker under the existing `test/conformance/` runner would need no new
  dependency but is a code change; it is deferred to a gated follow-up slice and is NOT part
  of this packet.

## Slice boundary and gates

This packet is documentation + schemas + one synthetic fixture. Nothing is enabled. Every
live-execution, activation, or deploy step named in [plan.md](./plan.md) and
[tasks.md](./tasks.md) is a separately approvable gate item and is default-off. This packet
does not complete or close #2185; the finalizer owns review.
