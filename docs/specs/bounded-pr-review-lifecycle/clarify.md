# Clarify: Bounded PR Review Lifecycle

Open questions resolved for `spec.md`. Each answer is normative for the contracts unless the
analysis (`analyze.md`) sends it back.

## Q1. What constitutes a new PR lineage?

A **PR lineage** is the sequence of review/correction generations that share one frozen
`IntentContractV1`. A lineage starts when a dispatcher or operator freezes the contract for a PR
(original base/head SHA recorded) and ends at any terminal state.

A **new** lineage — with a fresh budget — is created only when:

1. the operator explicitly disposes a terminal `blocked_needs_operator` or `intent_conflict`
   lineage and approves a new frozen intent (revised or identical); or
2. the PR is retargeted to a different goal/branch such that the old `intentHash` no longer
   describes the work (in practice this is case 1 with a revised contract).

A force-push, rebase, or branch update by the author does **not** by itself start a new lineage:
it produces a new generation **within** the lineage and is checked against the frozen intent.
This is the anti-gaming rule — otherwise every budget exhaustion could be escaped by re-pushing.

## Q2. Semantic vs metadata-only HEAD changes

Exact-HEAD binding (finalizer verdict subject binding, review receipt `headSha`/`diffHash`)
interacts with the lineage as follows:

- **Semantic change** — any change to files inside `declaredPaths.allowed` (or any tracked
  source file): produces a new `diffHash`; prior receipts bound to the old `diffHash` no longer
  cover the tree. Whether a fresh resolution run is required is decided by the lifecycle state,
  not by the hash alone (a correction generation *expects* exactly one such transition).
- **Metadata-only change** — commit-message edits, trailer additions, or changes confined to
  declared evidence/metadata files that do not alter the reviewed diff: the documented freshness
  path applies. `diffHash` is computed over the **diff content**, not the commit metadata, so a
  metadata-only change leaves `diffHash` unchanged and existing receipts remain valid. The
  `headSha` on receipts still records the exact head for audit, but freshness is judged on
  `diffHash` + `intentHash`.

Normalization before `intentHash`: whitespace/casing-equivalent restatements of goal text that
do not change meaning SHOULD be avoided rather than normalized away — the contract is frozen as
written; only serialization (key order, whitespace, encoding) is normalized. If the *words* of
the intent change, the hash changes, and the transition is `intent_conflict` unless the operator
disposes otherwise.

## Q3. Finding eligibility — edge cases

| Case | Treatment |
| --- | --- |
| Finding maps to no acceptance criterion or invariant | Non-blocking by default; reviewer must either link it to a criterion or record it as advisory |
| `spec_ambiguity` — the contract admits two reasonable readings | Blocking only if the chosen reading violates an invariant; otherwise routed to the finalizer/operator as a contract clarification, never silently resolved by the reviewer rewriting intent |
| `scope_drift` — patch outside `declaredPaths.allowed` | Blocking; candidate rejected; original head preserved. Forbidden paths remain the separate security boundary and block regardless of severity |
| Style / preference / optional design improvement | Non-blocking, always |
| Duplicate of an existing finding ID | Attached as additional evidence to the existing ID; increments the repeated-finding signature counter only if still unresolved |
| False finding (cf. #1209 synonym/config-flow misreads) | Finalizer marks `overruled_by_finalizer` with reason; counts toward reviewer-quality metrics, not toward the author |

## Q4. Operator override semantics

- Only the operator may dispose `blocked_needs_operator` or `intent_conflict`. Disposition
  options: start a new lineage (new frozen intent), accept the current head as-is via the
  **existing** approval path (this spec adds no bypass), or cancel.
- An operator override is recorded on the lineage record (who/when/why) and is visible in the
  metrics surface. Overrides never decrement budget counters retroactively — they close one
  lineage and may open another.
- Reviewer replacement is permitted only for classified infrastructure failure (worker offline,
  transport failure, evidence lane timeout) and consumes `maxReviewerReplacements`; it never
  resets `reviewerRuns`, wall clock, or finding state.

## Q5. What counts as a "correction generation"?

Any new head produced in response to blocking findings after the initial review. A generation
increments `correctionGenerations` exactly once per new head, regardless of how many findings it
resolves. Re-pushes that do not change `diffHash` do not create a generation.

## Q6. How does this interact with ordinary task retry policy?

Unchanged. `review_verdict_failed` remains hard-denied at the task level; repeated completion
submissions against a `running` task remain possible only until a terminal lineage state is
reached. In `enforce` mode the lineage terminal state, not task retry policy, is the stop
condition for the review loop as a whole.
