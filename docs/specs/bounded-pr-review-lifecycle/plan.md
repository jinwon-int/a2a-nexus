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

## Phase 11 — Producer completeness and privacy/retention plan

- Define one structured producer-fact contract whose five observation kinds
  are exhaustive at compile time.
- Reuse `parseReviewLineageObservation` as the only validation and projection
  boundary; do not infer from task status, result prose, logs, or providers.
- Classify canonical lineage as restricted sensitive, the minimized ledger as
  internal metadata, and only the existing scorecard projection as an
  approval-bound redacted export.
- Require an explicit approved cutoff with no default duration.
- Plan only terminal lineages strictly before that cutoff.
- Represent each candidate as one canonical-lineage-plus-ledger aggregate with
  expected version/state/count metadata.
- Build and fingerprint the validated scorecard export proof before creating
  any prune aggregate.

Phase 11 remains pure and source-only. It adds no automatic/disabled producer
plumbing, broker/store/worker/HTTP mutation, SQL deletion, live export,
deployment, restart, canary, real cohort, or runtime-default change.

## Phase 12 — Explicit producer-fact admission prerequisite

- Add one asynchronous unknown-input admission API.
- Return before parsing in default `off` mode.
- In `record` mode, reuse the Phase 11 projector and await one existing
  Phase 10 compound store command.
- Preserve post-ACK projection refresh and propagate every queue/store failure.
- Keep synchronous terminal and cancellation paths detached.
- Report automatic source coverage as `0/5` until authoritative structured
  carriers exist.

Phase 12 is a prerequisite, not an automatic producer. It adds no task/result
carrier, lifecycle call site, HTTP route, outbox/schema, live collection,
deployment, restart, or default change.

## Phase 13 — Authoritative source-carrier contract

- Define one exact-field untrusted carrier without authority or caller-selected
  producer/source-event identity.
- Issue authority separately as an immutable process-local trusted context.
- Assign all five observation kinds to an immutable source event and authority
  class with a compile-time exhaustive matrix.
- Derive identities deterministically from trusted issuer/namespace and the
  immutable event reference.
- Require review issuer identity to match the complete review receipt.
- Reuse the Phase 11 fact builder and Phase 8 parser as the complete validation
  boundary.
- Keep automatic source coverage at `0/5`.

Phase 13 is a source-only authorization contract. Its factory authenticates no
actor and has no runtime caller. Actual attachment requires a separately
approved authenticated owner plus an atomic source-and-lineage transaction or
an ACK-replayed transactional outbox/inbox.

## Phase 14 — First authenticated owner: operator cancel

- Add one exact operator-only review-lineage cancellation request.
- Fix source kind, authority, namespace, and issuer in trusted broker code;
  reject caller-selected authority or derived identity.
- Reuse the Phase 13 authorization, Phase 12 admission, and Phase 8 parser
  without a validation fork.
- Commit the authoritative source event, canonical lineage transition, and
  idempotency ledger in one SQLite `BEGIN IMMEDIATE`.
- Send the composite command through one worker-thread queue entry and refresh
  the broker projection only after its ACK.
- Prove role rejection, off-mode inertness, exact subject failure, source and
  ledger rollback, restart replay, changed-payload conflict, privacy, and
  unchanged task semantics.
- Report automatic coverage as exactly `1/5`.

Phase 14 attaches only the explicit `operator_cancel` source. Generic task
cancellation and task completion remain detached. The default stays `off`,
`enforce` remains unsupported, and no live schema execution, migration,
deployment, restart, canary, or real collection is approved.

## Phase 15 — Second authenticated owner: lineage create

- Ground lineage start in the normative operator authority: only an
  edge-authenticated requester with exact role `operator` may freeze a new
  contract through `POST /review-lineages`.
- Accept only an immutable dispatch reference, observation time, exact
  intent/head/diff binding, full `IntentContractV1`, and full
  `ReviewLineageBudgetV1`.
- Fix `lineage_contract_frozen`, semantic `lineage_dispatcher` authority,
  source namespace, and authenticated issuer in trusted broker code.
- Generalize attached-source metadata into a neutral shared type while keeping
  a closed tuple matrix for only create and cancel.
- Reuse the existing schema 13 source table and one SQLite transaction for
  source event, canonical lineage creation, and idempotency outcome.
- Prove role/field rejection, canonical-parser delegation, cross-kind
  rejection, off-mode inertness, restart replay, changed-evidence conflict,
  duplicate-lineage conflict, rollback, one worker ACK, privacy, and
  operator-cancel compatibility.
- Report automatic coverage as exactly `2/5`.

Phase 15 adds no task-creation observer or completion/retry/finalizer hook. It
does not change schema version or runtime defaults and approves no live
record-mode activation, deployment, restart, canary, or data collection.

## Phase 16 — Third authenticated owner: review report

- Add only `POST /review-lineages/{lineageId}/review-report`.
- Require the existing Ed25519 worker HTTP-signature registry and the dedicated
  `review-lineage.report` route scope.
- Treat the verified signing-key owner as the reviewer issuer; never accept an
  issuer from JSON.
- Make the canonical Phase 8 `ReviewReceiptV1` parser prove that issuer equals
  `receipt.reviewerNodeId`.
- Accept an exact immutable report reference, observation time, complete
  subject binding, complete receipt, and complete finding transitions.
- Fix `review_report_submitted`, `reviewer`, and the source namespace in trusted
  broker code.
- Reuse Phase 13 authorization, Phase 12 awaited admission, schema 13, and the
  existing composite transaction/worker command.
- Prove signature and scope denial, issuer mismatch, exact fields, off-mode
  inertness, direct and worker-thread atomicity, post-ACK projection, restart
  replay, changed-payload conflict, rollback, minimized metadata, and
  create/cancel compatibility.
- Keep correction generation and reviewer replacement detached.
- Report automatic coverage as exactly `3/5`.

Phase 16 adds no generic task completion/result/log/prose observer and changes
no finalizer, CodeQL, reviewer-independence, approval, retry, or task outcome.
The default remains `off`, `enforce` remains unsupported, and no live action is
approved.

## Phase 17 — Fourth authenticated owner: correction generation

- Add only
  `POST /review-lineages/{lineageId}/correction-generation`.
- Require an authenticated requester with the exact `operator` role, then
  assign semantic `correction_controller` authority in trusted broker code.
- Accept only an immutable generation reference, observation time, exact
  pre-correction intent/head/diff binding, next head and diff, frozen intent,
  and complete changed-path list.
- Fix `correction_generation_committed`, `correction_controller`, source
  namespace, and authenticated issuer in trusted code; derive producer and
  source-event identities without caller input.
- Reuse the Phase 8 parser, Phase 13 authorization, Phase 12 awaited admission,
  schema 13, and the existing composite transaction/worker command.
- Admit the event only while canonical state is `correction_pending`; preserve
  exact-subject, frozen-intent, forbidden-path, and allowed-path rejection.
- Prove exact route/fields/role, direct and worker-thread atomicity, post-ACK
  projection, off-mode inertness, restart replay, changed-payload conflict,
  rollback, minimized metadata, closed tuples, and create/review/cancel
  compatibility.
- Keep `reviewer_replacement` detached and report automatic coverage as exactly
  `4/5`.

Phase 17 records evidence for an already committed correction generation. It
does not apply a patch, invoke or auto-push fixer output, infer from generic
task/result/log/prose, or connect completion, retry, approval, or finalizer
paths. The default remains `off`, `enforce` remains unsupported, and no live
action is approved.

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
| 11 | Pure producer/retention modules have no call site; delete PR revert |
| 12 | Admission API has no automatic caller; delete PR revert |
| 13 | Pure carrier contract has no runtime caller; delete PR revert |
| 14 | Return mode to `off`, stop using the mutation route, and revert code; preserve additive source rows/tables for audit |
| 15 | Return mode to `off`, stop using the create route, and revert code; preserve canonical/source rows for audit |
| 16 | Return mode to `off`, stop using the signed review-report route, and revert code; preserve canonical/source rows for audit |
| 17 | Return mode to `off`, stop using the correction-generation route, and revert code; preserve canonical/source rows for audit |

## Safety boundaries (all phases)

- No phase grants push/merge/deploy/restart/publish authority to reviewer, finalizer, or fixer
  lanes.
- No production deploy, broker/Gateway/worker restart, DB/outbox/ACK/replay/prune/migration,
  provider send, release/tag, secret movement, visibility change, history rewrite, force push,
  or ruleset mutation is approved by this plan.
