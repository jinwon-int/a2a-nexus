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
- [x] Record-mode scorecard: elapsed time, generations, finding churn, stop reason — no private
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
- [x] Operator runbook: lineage metrics, terminal dispositions, new-lineage procedure
- [x] Dispatcher runbook: `payload.review.authorWorkerId` declaration; acceptance-command
      pitfall on analysis-only review tasks (#1548)
- [x] `docs/operators.md`: machine-visible `spec_ambiguity` / `scope_drift` dispositions
- [x] Rollout-mode defaults and scorecard readback recorded before any `enforce` default;
      fewer than 30 real terminal samples is explicitly `insufficient_evidence`, so defaults
      remain unchanged

## F. Detached-review closeout

- [ ] Detached independent review (evidence-only lane) confirms the implementation preserves
      original intent and does not create a new auto-fix loop
- [ ] Finalizer records the closeout disposition; exactly one finalizer owns it
- [ ] All evidence redacted: no secrets, private endpoints, provider IDs, Telegram IDs,
      production data, raw session dumps, or runtime/bootstrap files

## G. Lossless observation contract (Phase 8)

- [x] Versioned strict envelope requires producer/source identity, lineage,
      UTC time, exact intent/head/diff binding, and one complete engine input
- [x] Create accepts only `record`; runtime `enforce` remains unsupported
- [x] Review receipts and correction intent remain exact-subject/frozen-intent
      bound
- [x] Finding transitions are explicit, unique, and non-overlapping
- [x] Canonical idempotency key/fingerprint replay and conflict behavior tested
- [x] Unknown fields and sensitive prose/provider payload fields fail closed
- [x] Errors expose only stable code/path metadata
- [x] No broker/store/HTTP/task-completion/retry/finalizer call site exists
- [x] Durable reference adapter receives a separate Phase 9 review before any
      live collection
- [x] Producer completeness proof and privacy retention gate receive a
      separate review before any live collection

## H. Atomic durable reference adapter (Phase 9)

- [x] Lineage update and idempotency outcome share one SQLite transaction
- [x] Same-key replay never invokes a second lifecycle transition
- [x] Different fingerprint conflicts without overwriting the first outcome
- [x] Missing lineage and exact intent/head/diff subject conflicts replay
      stably
- [x] Version-guarded conditional update fails closed
- [x] Forced ledger-insert failure rolls back the preceding lineage write
- [x] Two independent SQLite connections produce one apply and one replay
- [x] Ledger excludes raw envelope, producer/source ids, free text, prompts,
      provider output, and rejected values
- [x] Reference tables have no production broker/snapshot/HTTP/producer call
      site
- [x] Production canonical lineage state and ledger atomicity proven in a
      separately reviewed integration

## I. Production SQLite atomic integration (Phase 10)

- [x] `SqliteBrokerStateStore` is the sole canonical lineage/ledger authority
- [x] Shared connection executes one `BEGIN IMMEDIATE` compound command
- [x] Broker Map refresh happens only after durable ACK
- [x] Worker-thread mode uses one queue entry and one worker request
- [x] Legacy snapshot import marker and canonical-wins precedence tested
- [x] Restart replay and same-key conflict remain stable
- [x] Forced ledger failure rolls back the lineage transition
- [x] Schema version 12 is recorded only after new tables initialize
- [x] No producer, HTTP mutation, completion/retry/finalizer hook, or live action
- [x] Producer completeness plus privacy/retention gate reviewed before live collection

## J. Producer completeness and privacy/retention plan (Phase 11)

- [x] All five observation kinds are exhaustive at compile time
- [x] Structured facts preserve stable source identity and exact subject
- [x] Missing, multiple, unknown, prose-only, and sensitive fields fail closed
- [x] Same fact is deterministic; changed payload under the same event identity
      preserves the key and changes the fingerprint
- [x] Canonical lineage and ledger are never approved export formats
- [x] Existing scorecard projection is the only redacted export proof
- [x] No retention plan exists without an explicit approved cutoff
- [x] Active and at-or-after-cutoff lineages cannot enter prune candidates
- [x] Candidate type couples canonical lineage and ledger rows
- [x] Export proof is validated and fingerprinted before candidate creation
- [x] No producer hook, SQL deletion, queue command, HTTP mutation, or live action
- [ ] Automatic producer and worker-owned atomic export/prune executor receive
      separate approvals

## K. Explicit producer-fact admission prerequisite (Phase 12)

- [x] Record-mode admission accepts only a complete Phase 11 producer fact
- [x] Off mode is inert before parser or store access
- [x] Record mode uses one parser projection and one compound command
- [x] The caller observes durable ACK before admission resolves
- [x] Queue saturation/abort/crash and store errors reject the caller Promise
- [x] Same fact replays through the existing durable idempotency ledger
- [x] Broker projection refresh remains post-ACK
- [x] Generic task completion/failure/cancellation never synthesize facts
- [x] No terminal API async conversion or fire-and-forget Promise
- [x] No route, outbox, schema, source subscription, or live collection
- [x] Automatic observation coverage is reported as `0/5`
- [x] Per-kind authority/source carrier contract reviewed
- [ ] Actual authenticated source owner and durable coupling reviewed before
      automatic attachment

## L. Authoritative source-carrier contract (Phase 13)

- [x] Serializable carrier cannot assert authority or derived identity
- [x] Exact carrier fields reject task/result/cancel and sensitive additions
- [x] Trusted context is separately factory-issued, immutable, and process-local
- [x] Cloned/reconstructed context fields do not recreate the capability
- [x] Five-kind source/authority matrix is compile-time exhaustive
- [x] Review issuer equals the complete receipt reviewer
- [x] Producer identity derives from authority, issuer, and namespace
- [x] Event identity derives from producer, source kind, and immutable reference
- [x] Payload changes preserve event identity and change the fingerprint
- [x] Phase 11 fact builder and Phase 8 parser remain canonical
- [x] No runtime owner, hook, route, store, outbox, schema, or live action
- [x] Automatic source coverage remains `0/5`
- [ ] First actual kind proves authenticated ownership and atomic/ACK-replayed
      durable coupling
