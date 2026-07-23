# Plan: Bounded PR Review Lifecycle

> Additive contracts first, record-mode telemetry second, enforcement last. No phase weakens an
> existing gate. Each phase is a separately reviewable PR.

## Phase 0 — Spec packet (this PR)

- Land `docs/specs/bounded-pr-review-lifecycle/` (spec, clarify, analyze, plan, tasks,
  checklist).
- No code. Success: spec PR merged; open design questions from analyze.md coverage-gaps table
  carried into Phase 2.

## Phase 1 — Machine-readable contracts + fixtures

- Add JSON schemas for `IntentContractV1`, `ReviewLineageBudgetV1`, `FindingLedgerV1`, and the
  extended review receipt under the contracts/fixtures convention (`fixtures/contract/`,
  mirroring `a2a-goal-mode` `schema.json` + fixture pattern).
- Canonicalization + `intentHash` reference implementation (serialization-only normalization per
  clarify Q2) with golden vectors: stable hash for equivalent serialization; changed hash for any
  goal/non-goal/invariant/criterion/path/base/head change.
- Pin the `diffHash` definition (analyze.md gap): diff algorithm, rename handling, empty-diff
  behavior.
- RED tests first: schema conformance fixtures (valid + invalid), hash golden vectors.

## Phase 2 — Trusted-author review receipt slice (#1548 defect, smallest code change)

- Additive optional `task.payload.review.authorWorkerId`; parse in `parseTaskReview`
  (`worker-review.ts`); thread into `validateReviewEvidence` at the completion path
  (`worker.ts:431`/`816`).
- Independence check compares reviewer against the declared author when present; fallback
  (`claimedBy` → `assignedWorkerId` → `targetNodeId`) unchanged when absent.
- Tests: self-contained review task with declared different author passes; declared same author
  fails `review_not_independent`; absent field preserves current behavior; analysis-only review
  task without `acceptance.command` passes review validation (regression guard for the #1548
  acceptance pitfall).
- Dispatcher docs note: do not attach `acceptance.command` to analysis-only review tasks.

## Phase 3 — Broker record-mode lineage state

- Decide lineage-state placement (analyze.md gap: new read model vs. task metadata) and
  implement **record mode only**: lifecycle state, budget counters, finding ledger persisted and
  projected; zero behavior change on the completion path.
- Wire budget-counter increments (generation, reviewer run/replacement, wall clock) and finding
  churn into the operator metrics surface.
- Fixtures: full initial-review → one correction → resolution flow reaching `passed`;
  non-converging flow reaching `blocked_needs_operator`; moving-goalpost flow rejected;
  scope-drift flow rejected with original head recoverable.

## Phase 4 — Early stop + terminal exhaustion (still record-visible, enforce behind flag)

- Repeated-identical-signature early stop (`repeatedFindingThreshold`).
- Exhaustion transitions to `blocked_needs_operator`; intent drift to `intent_conflict`.
- Per-lineage kill switch remains `off`/`record`; `enforce` flips only per-lineage opt-in for
  conformance fixtures in this phase.

## Phase 5 — Resolution-review restrictions + isolated patch-candidate boundary

- Resolution pass accepts resolve/reopen of existing finding IDs; new blockers only for
  introduced-regression / critical-security / unavailable-evidence with justification.
- Fixer lane output is an isolated patch candidate (additive child generation); original author
  head immutability verified by test; no auto-push path exists.
- Appeal flow: exactly one finalizer disposition per finding (`overruled_by_finalizer` /
  upheld).

## Phase 6 — Enforce-mode conformance + finalizer-gate / #1499 integration

- `scripts/a2ad-finalizer-gate.mjs` consumes lineage evidence (budget state, finding ledger,
  terminal state) as an additional input — never as a replacement for signed verdict
  verification.
- Full deterministic contract-test checklist (checklist.md) green; `npm run check`,
  public-readiness scan, and CI green.
- Detached independent review (evidence-only lane) confirms the implementation preserves
  original intent and creates no new auto-fix loop.

## Phase 7 — Scorecard readback before any default-on

- Record-mode scorecard across real lineages: elapsed time, generation count, finding churn,
  stop reasons, false-positive rate on `intentHash`.
- Budget defaults tuned from evidence; broad `enforce` default is a separate operator decision,
  documented like the rollout of previous gates.

Implementation status: the versioned redacted projection, deterministic offline
scorecard, explicit `intentHash` adjudication contract, and advisory-only budget
thresholds are implemented. Cohorts below 30 real terminal lineages report
`insufficient_evidence`; no default changes at that state. Collection of the
first evidence-qualified real cohort remains open, and runtime `enforce`
continues to require a separate operator decision.

## Rollback strategy per phase

| Phase | Rollback |
| --- | --- |
| 1 | Schemas/fixtures are additive files; delete PR revert |
| 2 | Optional field; revert restores fallback-only validation |
| 3 | Record mode is write-only telemetry; ignore/disable without migration |
| 4–5 | Per-lineage mode flag back to `record` |
| 6 | Gate input removed; signed-verdict path untouched |
| 7 | Defaults stay `record` |

## Safety boundaries (all phases)

- No phase grants push/merge/deploy/restart/publish authority to reviewer, finalizer, or fixer
  lanes.
- No production deploy, broker/Gateway/worker restart, DB/outbox/ACK/replay/prune/migration,
  provider send, release/tag, secret movement, visibility change, history rewrite, force push,
  or ruleset mutation is approved by this plan.
