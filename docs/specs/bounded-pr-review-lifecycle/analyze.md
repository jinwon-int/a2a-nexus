# Spec Analysis: Bounded PR Review Lifecycle

## Inputs

- Spec: `docs/specs/bounded-pr-review-lifecycle/spec.md`
- Clarify: `docs/specs/bounded-pr-review-lifecycle/clarify.md`
- Related issues: #1518 (this packet), #1499 (finalizer/CodeQL ruleset), #1027 (task-level
  early-stop), #1209 (false findings), #1548 (review_not_independent defect)
- Existing references: `packages/broker/src/worker-review.ts`, `packages/broker/src/worker.ts`,
  `docs/implementation-pipeline.md`, `docs/a2ad-round-dispatch.md`, `docs/operators.md`

## Consistency checks

- [x] Problem statement matches scope — every gap listed in the issue (no max duration, unbounded
  correction generations, composing bounded rounds, unbound review receipt, narrative-only
  failure modes) maps to a contract section in the spec.
- [x] Required invariants 1–7 from the issue each have an enforcing mechanism: frozen intent
  (IntentContractV1), read-only review (authority table), one global budget
  (ReviewLineageBudgetV1), stable findings (FindingLedgerV1), resolution-check-only second pass
  (restrictions), terminal visible exhaustion (lifecycle), exact-subject binding preserved
  (#1499 section).
- [x] In-scope and out-of-scope are cleanly separated; no deploy/restart/DB/ruleset mutation in
  scope.
- [x] The #1548 trusted-author-identity slice is additive (optional `authorWorkerId` with
  backward-compatible fallback) and does not change existing receipt semantics when absent.
- [x] Rollback exists — `off`/`record` modes precede `enforce`; record mode cannot strand tasks.

## Safety checks

- [x] Fail-closed preserved — hash/identity mismatches reject; exhaustion goes to a terminal
  state, never auto-retry; finalizer verdict, CodeQL, independence, and approval gates are
  explicitly out of scope to weaken.
- [x] Secrets/private data — contracts carry SHAs, paths, IDs, and dispositions only.
- [x] Approval-sensitive actions named — ruleset mutation (#1499 coordination), enforce-mode
  activation, and any broker deploy remain separately approved.
- [x] Anti-gaming — re-push does not start a new lineage; reviewer replacement does not reset
  budget; overruled findings cannot be reopened by the same reviewer without new-evidence
  classes.
- [x] Evidence sufficiency — metrics (elapsed, generations, churn, stop reason) let the operator
  judge convergence without private prompts or chain-of-thought.

## Safety/liveness trade-offs

| Tension | Resolution |
| --- | --- |
| Strict gate (#1499) vs. loop termination | Gate judges individual heads; lifecycle bounds the number of heads. Neither replaces the other. |
| Frozen intent vs. legitimate mid-review learning | Genuine intent change is possible only via `intent_conflict` → operator disposition → new lineage. Learning is routed through a human, not absorbed silently. |
| Bounded corrections vs. real multi-round defects | Default `maxCorrectionGenerations=1` is a default, not a cap on operator-approved new lineages. Cost of a new lineage is explicit disposition; cost of unbounded lineage is the incident class this spec removes. |
| Early stop (repeated findings) vs. false-positive findings | `overruled_by_finalizer` removes false findings from the author's critical path; repeated-finding early stop fires on *unresolved identical signatures*, so a productive correction always resets progress. |

## Exact-HEAD freshness interaction

- Receipt freshness is judged on `diffHash` + `intentHash`, so metadata-only HEAD changes
  (commit-message/trailer edits) do not invalidate review evidence (clarify Q2).
- Finalizer verdict exact-subject binding is untouched: this spec's receipts are lineage-level
  evidence consumed by the finalizer, not a substitute for the signed verdict.
- Risk: an attacker reusing a `diffHash` across a different base. Mitigation: `baseSha` is part
  of the frozen contract and `intentHash` covers it.

## False-positive and reviewer-replacement risks

| Risk | Mitigation |
| --- | --- |
| `intentHash` false positives from harmless rewording | Contract is frozen as written; normalization is serialization-only. Rewording = new hash = `intent_conflict` with operator disposition (deliberately conservative in enforce mode; measured in record mode first). |
| Reviewer replacement gaming (swap until PASS) | Replacement only for classified infra failure, bounded by `maxReviewerReplacements`, never resets counters; replacement events are metric-visible. |
| Finding-signature collisions suppressing real new findings | Signature covers criterionRef + category + normalized evidence; collisions attach as evidence to the existing ID rather than being dropped. |
| Self-contained review tasks still failing independence | Dispatcher declares `payload.review.authorWorkerId`; validator receives it explicitly; conformance tests cover author==reviewer rejection and trusted-author pass. |

## Compatibility with #1499

- [x] #1499 remains required; this spec adds no merge-gate bypass and no automatic acceptance of
  reviewer/fixer output.
- [x] The lifecycle's terminal `passed` is a *review-lifecycle* judgment; merge still requires
  the finalizer verdict and CodeQL green in the active ruleset.
- [x] Enforce-mode activation and any ruleset change are separately approved operator actions.

## Coverage gaps

| Gap | Severity | Required fix before implementation? | Owner |
| --- | --- | --- | --- |
| `diffHash` exact definition (diff algorithm, rename handling) | Medium | Yes — pin in Phase 2 schema work | broker/contracts |
| Where lineage state lives in the broker store (new read model vs. task metadata) | Medium | Yes — plan Phase 3 decision | broker |
| GitHub-review layer signal ingestion (approvals/CHANGES_REQUESTED → finding dispositions) | Medium | No — record mode can start broker-side only | follow-up |
| Default budget values are recommendations, not measured | Low | No — record-mode scorecard tunes them | operator |
| Multi-reviewer aggregation within one run | Low | No — out of scope for the first slice (same as A2AD) | follow-up |

## Analysis outcome

- [x] Ready for specification PR.
- [ ] Needs plan update.
- [ ] Needs tasks update.
