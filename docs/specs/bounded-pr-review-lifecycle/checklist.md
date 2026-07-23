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

- [x] `IntentContractV1` canonicalization: stable `intentHash`; any
      goal/non-goal/invariant/acceptance/scope/base/head change changes the hash
- [x] Review receipt with mismatched `headSha`, `diffHash`, or `intentHash` fails closed
- [x] Reviewer identity equal to author remains rejected (declared author and fallback paths)
- [x] Review/finalizer/fixer contracts cannot carry write-capable execution authority
- [x] Failed initial review permits at most the configured correction generation count
- [x] Wall-clock / reviewer-run / correction-generation / no-progress exhaustion →
      `blocked_needs_operator`, not `running`, not auto-retry
- [x] Correction changing frozen intent → `intent_conflict`, explicit operator disposition
- [x] Resolution review resolves/reopens prior IDs but rejects new preference/scope-expansion
      blockers
- [x] Resolution review adds introduced-regression / critical-security blocker only with exact
      evidence and justification
- [x] Appeal disposition binds one finalizer owner and records exactly one decision per finding
- [x] Fixer candidate is proposal-only; validation/acceptance preserve the original author HEAD
      and expose no apply/push path
- [x] Repeated identical unresolved finding signatures trigger early stop before outer budget
- [x] Reviewer replacement only for classified infrastructure failure; never resets lineage
      budget
- [x] Metadata/evidence-only HEAD changes follow the documented freshness path without weakening
      exact finalizer subject binding
- [x] Existing task retry hard-deny and finalizer-verdict verification remain green

## C. Integration / simulation (Phases 3–6)

- [x] Converging fixture: initial review → one correction → resolution PASS, no third generation
- [x] Non-converging fixture: repeated findings → `blocked_needs_operator` within budget
- [x] Moving-goalpost fixture: second reviewer cannot introduce unrelated design blocker
- [x] Scope-drift fixture: out-of-paths patch rejected; immutable original recoverable
- [ ] Record-mode scorecard: elapsed time, generations, finding churn, stop reason — no private
      prompts or chain-of-thought

## D. Broker / gate integration

- [x] Record mode: lineage state + metrics with zero completion-path behavior change
- [x] `scripts/a2ad-finalizer-gate.mjs` consumes strict, round-bound lineage evidence
      additively; omitted input preserves the legacy result shape
- [x] Focused broker tests, finalizer gate tests, conformance tests green
- [x] `npm run check` green
- [x] `npm run scan:public-readiness` green
- [ ] CI green on every phase PR

## E. Docs

- [x] A2AD finalizer runbook: optional `--lineage` envelope, mode semantics,
      fail-closed composition, and explicit no-runtime/no-ruleset boundary
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
