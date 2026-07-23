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

## Phase 8 — Lossless observation contract before live collection

- Add strict `ReviewLineageObservationEnvelopeV1` schema/types for complete
  record-mode create and lifecycle-event inputs.
- Derive a domain-separated idempotency key and canonical payload fingerprint;
  same-key/same-payload replay deduplicates, while same-key/different-payload
  fails closed.
- Preserve an exact compare-and-set subject (`intentHash`, current `headSha`,
  canonical `diffHash`) beside the projected existing engine command.
- Reject missing/unknown/inferred fields and return only redacted error
  code/path metadata.

Phase 8 is source-only and pure. It adds no task-completion observer,
broker/store/HTTP mutation call site, persistent dedupe ledger, deploy, or
runtime-mode change. A separately reviewed adapter is required before real
record-mode collection can begin.

## Phase 9 — Atomic durable observation reference adapter

- Add a persistence-neutral atomic apply/result contract for normalized Phase
  8 commands.
- Add a detached SQLite reference implementation whose lineage state and
  idempotency ledger share one `BEGIN IMMEDIATE` transaction.
- Persist stable applied/missing/subject/transition outcomes so replay cannot
  change after later lineage mutations.
- Prove restart replay, concurrent duplicate serialization, payload conflict,
  exact intent/head/diff CAS, rollback after a lineage write, and ledger
  privacy with temporary-file databases.

Phase 9 remains source-only. Its versioned tables are not attached to the
production broker database or snapshot, and there is no broker, persistence
queue, HTTP, task-completion, retry, finalizer, or producer call site. A later
integration must prove the canonical production lineage state and ledger share
one commit boundary; independent snapshot and ledger writes are forbidden.

## Phase 10 — Production SQLite atomic integration

- Reuse the Phase 9 repository on the `SqliteBrokerStateStore` connection so
  lineage and ledger have one production SQLite authority.
- Make `BrokerSnapshot.reviewLineages` legacy import / derived compatibility
  data; a versioned marker prevents stale snapshot re-import.
- Add one explicit async broker observation method that refreshes the in-memory
  read projection only after the durable commit.
- Route the complete compound command through one worker-thread persistence
  queue entry and one worker request.
- Prove production-store restart/replay, rollback, legacy import precedence, and
  worker-thread ACK/readback with temporary databases.

Phase 10 remains source-only. It does not add an automatic producer, HTTP
mutation route, task-completion/retry/finalizer hook, deploy/restart, live
schema execution, retention/pruning/export, or real cohort collection.

## Rollback strategy per phase

| Phase | Rollback |
| --- | --- |
| 1 | Schemas/fixtures are additive files; delete PR revert |
| 2 | Optional field; revert restores fallback-only validation |
| 3 | Record mode is write-only telemetry; ignore/disable without migration |
| 4–5 | Per-lineage mode flag back to `record` |
| 6 | Gate input removed; signed-verdict path untouched |
| 7 | Defaults stay `record` |
| 8 | Observation schema/projector are additive files; delete PR revert |
| 9 | Detached reference tables have no runtime constructor; delete PR revert |
| 10 | Atomic API is unused without a producer; preserve additive tables during rollback |

## Safety boundaries (all phases)

- No phase grants push/merge/deploy/restart/publish authority to reviewer, finalizer, or fixer
  lanes.
- No production deploy, broker/Gateway/worker restart, DB/outbox/ACK/replay/prune/migration,
  provider send, release/tag, secret movement, visibility change, history rewrite, force push,
  or ruleset mutation is approved by this plan.
