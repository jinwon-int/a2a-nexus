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

## Phase 4: Early stop + terminal exhaustion

- Repeated-identical-signature early stop before outer budget consumption.
- Wall-clock / generation / reviewer-run exhaustion → `blocked_needs_operator` (never
  `running`, never auto-retry).
- Frozen-intent change in a correction → `intent_conflict`.

Acceptance: per-lineage mode flag; `enforce` only for conformance fixtures in this phase.

## Phase 5: Resolution restrictions + isolated patch candidate

- Resolution pass: resolve/reopen existing IDs; new blockers restricted to introduced-regression
  / critical-security / unavailable-evidence with justification.
- Fixer lane: isolated additive patch candidate; original author head immutable (test); no
  auto-push path.
- Appeal: exactly one finalizer disposition per finding.

## Phase 6: Enforce-mode conformance + #1499 integration

- `scripts/a2ad-finalizer-gate.mjs` consumes lineage evidence as additive input; signed-verdict
  verification untouched.
- Full checklist (checklist.md) green; `npm run check`, public-readiness scan, CI green.
- Detached independent review (evidence-only) confirms intent preservation and no new auto-fix
  loop.

## Phase 7: Scorecard readback

- Record-mode scorecard over real lineages; budget defaults tuned from evidence.
- Broad `enforce` default: separate operator decision, documented.

## Validation commands (all phases as applicable)

```bash
npm run check
npm run scan:public-readiness
node --test packages/broker/src/worker-review.test.ts
```
