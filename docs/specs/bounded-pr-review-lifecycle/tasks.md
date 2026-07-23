# Tasks: Bounded PR Review Lifecycle Implementation

> Required before implementation (per #1518). Phase numbering matches `plan.md`.
> Every phase: RED first for gates/contracts; no phase weakens finalizer verdict, CodeQL,
> reviewer independence, required checks, or operator approvals.

## Prerequisites

- [ ] Spec packet PR (`docs/specs/bounded-pr-review-lifecycle/`) is merged.
- [ ] Open design questions assigned from `analyze.md` coverage gaps (`diffHash` definition,
      lineage-state placement).

## Phase 1: Machine-readable contracts + fixtures

### 1.1 Schemas

Create JSON schemas for `IntentContractV1`, `ReviewLineageBudgetV1`, `FindingLedgerV1`, and the
extended review receipt (additive fields: `headSha`, `diffHash`, `intentHash`,
`findingLedgerRef`, dispatcher-declared `authorWorkerId`).

Acceptance: schemas live beside the contracts/fixtures convention (`fixtures/contract/` +
schema sibling, mirroring `a2a-goal-mode`); invalid fixtures fail closed.

### 1.2 Canonicalization + intentHash golden vectors

- Reference canonicalization (sorted keys, UTF-8, no insignificant whitespace;
  serialization-only normalization).
- Golden vectors: identical serialization → identical `intentHash`; any change to goal,
  non-goals, invariants, acceptance criteria, declared paths, base, or head → different hash.

Acceptance: conformance test exits 0 on all vectors.

### 1.3 diffHash definition

Pin algorithm, rename handling, and empty-diff behavior; document in the schema doc and cover
with vectors including a metadata-only commit change (same `diffHash`) and a semantic change
(different `diffHash`).

## Phase 2: Trusted-author review receipt slice (#1548)

### 2.1 Parse + validate

- `parseTaskReview` accepts optional `payload.review.authorWorkerId` (string); malformed values
  fail closed with `review_evidence_missing`.
- Completion path (`validateTaskCompletionEvidence`) threads the declared author into
  `validateReviewEvidence`; independence compares reviewer against declared author when present,
  else the existing fallback.

### 2.2 Tests (RED → GREEN)

- Self-contained review task with declared different author → passes.
- Declared author equal to reviewer → `review_not_independent`.
- Absent field → current fallback behavior unchanged (existing `worker-review.test.ts` green).
- Analysis-only review task without `acceptance.command` → review validation passes; with an
  unexecuted `acceptance.command` → `acceptance_evidence_missing` (documented pitfall guard).

Acceptance: `node --test packages/broker/src/worker-review.test.ts` (and acceptance suite) green.

## Phase 3: Broker record-mode lineage state

### 3.1 State + read model

- Lineage record: state machine (`reviewing_initial` … terminal), budget counters, finding
  ledger; projected read model for operators.
- Record mode only: no completion-path behavior change.

### 3.2 Metrics surface

Elapsed wall time, correction generations, reviewer runs/replacements, finding churn
(new/reopened/resolved), repeated-signature hits, drift dispositions, terminal stop reason.

Acceptance: broker focused tests green; record mode emits metrics for a simulated lineage with
zero effect on completion validation.

### 3.3 Simulation fixtures

- Converging: initial review → one correction → resolution `passed`, no third generation.
- Non-converging: repeated findings → `blocked_needs_operator` within budget.
- Moving-goalpost: second reviewer cannot add unrelated design blocker.
- Scope-drift: patch outside declared paths rejected; original head recoverable.

Implementation boundary: promote these scenarios into strict, reusable JSON
fixtures backed by the pure lifecycle engine. Actual task-completion observation
remains a later contract-first slice because the current review payload does not
declare the full intent contract, diff binding, stable finding ledger, or
idempotency key needed to construct lossless lineage events.

## Phase 4: Early stop + terminal exhaustion

- [x] Repeated-identical-signature early stop before outer budget consumption.
- [x] Wall-clock / generation / reviewer-run exhaustion → `blocked_needs_operator` (never
      `running`, never auto-retry).
- [x] Frozen-intent change in a correction → `intent_conflict`.

Acceptance: per-lineage mode flag; `enforce` only for conformance fixtures in this phase.

Phase 4 boundary: the lifecycle engine's existing terminal transitions feed a
pure enforcement-decision contract exercised by strict conformance fixtures.
`off` and `record` decisions leave completion/retry behavior unchanged. Runtime
broker configuration continues to reject `enforce`; no task-completion, retry,
finalizer, persistence-observer, or HTTP mutation call site is added. Runtime
enforcement remains contract-first work for a later phase after lossless review
event inputs and idempotency are available.

## Phase 5: Resolution restrictions + isolated patch candidate

- [x] Resolution pass: resolve/reopen existing IDs; new blockers restricted to introduced-regression
  / critical-security / unavailable-evidence with justification.
- [x] Fixer lane: isolated additive patch candidate; original author head immutable (test); no
  auto-push path.
- [x] Appeal: exactly one finalizer disposition per finding.

Phase 5 boundary: `appeal.ts` and `patch-candidate.ts` are independent,
pure-contract modules. Appeal requests and finalizer dispositions are embedded
in the durable lineage record, with one lineage owner and one disposition per
finding. Fixer candidates are `propose_only`, bind the frozen HEAD/diff/intent
and allowed paths, and require a separate operator acceptance contract. Neither
validation nor acceptance applies a correction event, writes Git, pushes a
branch, or adds a runtime call site. Authenticated operator/finalizer identity,
patch-byte digest/path recomputation, runtime effects, and the signed finalizer
gate remain Phase 6+ work.

## Phase 6: Enforce-mode conformance + #1499 integration

- [x] `scripts/a2ad-finalizer-gate.mjs` consumes a strict, round-bound lineage evidence
  envelope as optional additive input; signed-verdict verification is untouched.
- Full checklist (checklist.md) green; `npm run check`, public-readiness scan, CI green.
- Detached independent review (evidence-only) confirms intent preservation and no new auto-fix
  loop.

Phase 6 source boundary: `off`/`record` remain observational, `enforce` evidence
fails closed unless the durable record is consistently `passed`, and no broker
runtime acceptance, completion/retry hook, fixer apply path, deploy/restart, or
#1499 ruleset mutation is added.

## Phase 7: Scorecard readback

- [x] Strict `a2a.review-lineage-scorecard-input.v1` redacted envelope and
  deterministic offline aggregation.
- [x] Scorecard reports elapsed time, generations, reviewer runs/replacements,
  finding churn, repeated-signature hits, drift/goalpost rejections, open
  blockers, terminal reasons, and explicitly adjudicated `intentHash`
  false-positive behavior.
- [x] Budget cohorts are separated by exact budget signature; recommendations
  are advisory-only with 30/100 terminal-sample floors and no apply/runtime
  consumer.
- [ ] Record-mode scorecard over at least 30 real terminal lineages; tune budget
  defaults only if the committed evidence crosses an advisory threshold.
- [x] Broad `enforce` default remains a separate operator decision; runtime
  continues to accept only `off` / `record`.

Phase 7 source boundary: the CLI consumes only an offline redacted export,
validates before writing, and rejects a same-round/different-digest replay.
The synthetic fixture documents the contract and is not rollout evidence. Until
real terminal samples reach the minimum cohort size, the recorded disposition
is `insufficient_evidence` and `DEFAULT_LINEAGE_BUDGET` remains unchanged.

## Phase 8: Lossless record-mode observation input

- [x] Strict `ReviewLineageObservationEnvelopeV1` schema and TypeScript types.
- [x] Complete explicit mapping to existing lineage create/review/correction/
      replacement/cancel inputs; no prose or task-status inference.
- [x] Exact expected-subject binding for future compare-and-set application.
- [x] Domain-separated idempotency key and canonical payload fingerprint.
- [x] Same-key/same-payload batch replay dedupe and same-key/different-payload
      conflict rejection.
- [x] Unknown fields/version/mode, malformed or mismatched hashes, incomplete
      finding transitions, and non-independent declared reviewer fail closed.
- [x] Errors expose stable code/path only and do not echo rejected values.
- [x] Durable idempotency ledger + exact-subject reference store adapter
      implemented and reviewed separately in Phase 9.
- [ ] Approved producer completeness and privacy/retention proof before a live
      task-completion observer is attached.

Phase 8 source boundary: `observation.ts` is a pure validator/projector. It does
not import or call the broker/store, add an HTTP mutation route, observe task
completion/retry/finalizer output, or change runtime `off` / `record` defaults.

## Phase 9: Atomic durable observation reference adapter

- [x] Persistence-neutral apply/result interface consumes only the normalized
      Phase 8 command.
- [x] SQLite reference lineage and idempotency tables commit in one immediate
      transaction.
- [x] Same key/same fingerprint replays the stored outcome without an engine
      call; a different fingerprint conflicts without mutation.
- [x] `missing_lineage`, `subject_conflict`, and `transition_rejected` are
      stable recorded outcomes.
- [x] Create uses absence-CAS; events compare exact intent/head/diff and update
      a monotonic record version conditionally.
- [x] Restart, two-connection race, per-field subject mismatch, forced rollback,
      and ledger privacy tests pass on temporary databases.
- [x] No production broker DB/snapshot, HTTP, task completion/retry/finalizer,
      persistence queue, or producer integration exists.
- [x] Production integration proves canonical lineage state and ledger share
      one SQLite commit boundary.
- [ ] Producer completeness, retention/pruning/export policy, and real
      terminal-lineage collection receive separate approval and review.

Phase 9 source boundary: the SQLite class is a detached reference constructor
used only by tests. Instantiating it against the live broker database, migrating
live tables, or attaching an observation producer is not authorized.

## Phase 10: Production SQLite atomic integration

- [x] `SqliteBrokerStateStore` owns the Phase 9 repository on its existing
      SQLite connection.
- [x] The dedicated lineage table is canonical; snapshot lineages import once
      under a durable marker and cannot overwrite canonical rows.
- [x] Broker projection refresh occurs only after a durable compound-command
      result.
- [x] Direct Map-first mutation is rejected for atomic SQLite stores.
- [x] Worker-thread mode sends one queue entry and one worker request for the
      complete transaction.
- [x] Production store restart/replay, forced rollback, legacy precedence, and
      worker-thread ACK/readback pass on temporary databases.
- [x] Broker schema version 12 is published after lineage tables initialize.
- [ ] Complete automatic producer contract and privacy/retention proof.
- [ ] Separate approval for live schema execution, migration, deploy/restart,
      canary, or real-lineage collection.

Phase 10 source boundary: an explicit broker/store API exists, but there is no
automatic caller, HTTP mutation route, or task-completion/retry/finalizer hook.

## Validation commands (all phases as applicable)

```bash
npm run check
npm run scan:public-readiness
node --test packages/broker/src/worker-review.test.ts
```
