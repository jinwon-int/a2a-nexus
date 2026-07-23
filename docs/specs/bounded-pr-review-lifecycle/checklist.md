# Checklist: Bounded PR Review Lifecycle Closeout

> Master closeout checklist for #1518. Maps to the issue's evidence/validation contract.
> Phase references are to `plan.md` / `tasks.md`. Nothing here approves deploys, restarts,
> DB mutation, releases, secret movement, or ruleset changes.

## A. Spec packet (Phase 0 — this PR)

- [x] `spec.md` — intent contract, global lineage budget, lifecycle states, reviewer/finalizer
      authority
- [x] `clarify.md` — new-lineage definition, semantic vs metadata-only HEAD, finding
      eligibility, operator override semantics
- [x] `analyze.md` — safety/liveness trade-offs, exact-HEAD freshness interaction,
      false-positive and reviewer-replacement risks, #1499 compatibility
- [x] `plan.md` — additive schemas → record-mode telemetry → enforcement
- [x] `tasks.md` — implementation tasks
- [x] `checklist.md` — this file

## B. Deterministic contract tests (Phases 1–2)

- [ ] `IntentContractV1` canonicalization: stable `intentHash`; any
      goal/non-goal/invariant/acceptance/scope/base/head change changes the hash
- [ ] Review receipt with mismatched `headSha`, `diffHash`, or `intentHash` fails closed
- [ ] Reviewer identity equal to author remains rejected (declared author and fallback paths)
- [ ] Review/finalizer lanes cannot carry write-capable execution authority
- [ ] Failed initial review permits at most the configured correction generation count
- [ ] Wall-clock / reviewer-run / correction-generation / no-progress exhaustion →
      `blocked_needs_operator`, not `running`, not auto-retry
- [ ] Correction changing frozen intent → `intent_conflict`, explicit operator disposition
- [ ] Resolution review resolves/reopens prior IDs but rejects new preference/scope-expansion
      blockers
- [ ] Resolution review adds introduced-regression / critical-security blocker only with exact
      evidence and justification
- [ ] Repeated identical unresolved finding signatures trigger early stop before outer budget
- [ ] Reviewer replacement only for classified infrastructure failure; never resets lineage
      budget
- [ ] Metadata/evidence-only HEAD changes follow the documented freshness path without weakening
      exact finalizer subject binding
- [ ] Existing task retry hard-deny and finalizer-verdict verification remain green

## C. Integration / simulation (Phases 3–6)

- [ ] Converging fixture: initial review → one correction → resolution PASS, no third generation
- [ ] Non-converging fixture: repeated findings → `blocked_needs_operator` within budget
- [ ] Moving-goalpost fixture: second reviewer cannot introduce unrelated design blocker
- [ ] Scope-drift fixture: out-of-paths patch rejected; immutable original recoverable
- [ ] Record-mode scorecard: elapsed time, generations, finding churn, stop reason — no private
      prompts or chain-of-thought

## D. Broker / gate integration

- [x] Record mode: lineage state + metrics with zero completion-path behavior change
- [ ] `scripts/a2ad-finalizer-gate.mjs` consumes lineage evidence additively
- [ ] Focused broker tests, finalizer gate tests, conformance tests green
- [ ] `npm run check` green
- [ ] `npm run scan:public-readiness` green
- [ ] CI green on every phase PR

## E. Docs

- [ ] Operator runbook: lineage metrics, terminal dispositions, new-lineage procedure
- [ ] Dispatcher runbook: `payload.review.authorWorkerId` declaration; acceptance-command
      pitfall on analysis-only review tasks (#1548)
- [ ] `docs/operators.md`: machine-visible `spec_ambiguity` / `scope_drift` dispositions
- [ ] Rollout-mode defaults and scorecard readback recorded before any `enforce` default

## F. Detached-review closeout

- [ ] Detached independent review (evidence-only lane) confirms the implementation preserves
      original intent and does not create a new auto-fix loop
- [ ] Finalizer records the closeout disposition; exactly one finalizer owns it
- [ ] All evidence redacted: no secrets, private endpoints, provider IDs, Telegram IDs,
      production data, raw session dumps, or runtime/bootstrap files
