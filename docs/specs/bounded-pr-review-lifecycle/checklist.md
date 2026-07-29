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
- [x] Actual authenticated source owner and durable coupling reviewed before
      the first automatic attachment

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
- [x] First actual kind proves authenticated ownership and atomic/ACK-replayed
      durable coupling

## M. First authenticated owner — operator cancel (Phase 14)

- [x] Mutation route requires the exact operator role
- [x] Request cannot select source kind, authority, namespace, issuer, or
      producer/source-event identity
- [x] Trusted context is created only after the operator gate
- [x] Phase 13 carrier authorization and Phase 12/8 admission chain remain
      canonical
- [x] Source event, lineage transition, and ledger share one transaction
- [x] Worker-thread mode sends one composite command and returns one ACK
- [x] Projection refresh happens only after the composite durable ACK
- [x] Restart replay returns the stored outcome without another transition
- [x] Changed payload under one decision reference conflicts without overwrite
- [x] Forced source and ledger failures roll back all coupled writes
- [x] Source table excludes raw request, decision reference, detail, prompts,
      credentials, provider output, and production payloads
- [x] Generic task cancel/completion/retry/finalizer paths remain unchanged
- [x] Default mode remains `off`; `enforce` remains unsupported
- [x] Automatic source coverage is exactly `1/5`
- [ ] Live schema execution, record-mode activation, deploy/restart/canary, and
      real-lineage collection receive separate explicit approval
- [x] Second source kind receives a separate owner/durability review
- [x] Third source kind receives a separate owner/durability review
- [x] Fourth source kind receives a separate owner/durability review
- [ ] Remaining source kind receives a separate owner/durability review

## N. Second authenticated owner — lineage create (Phase 15)

- [x] Normative new-lineage owner is an exact-role operator
- [x] `POST /review-lineages` rejects non-operators before authorization
- [x] Request cannot select source/authority/namespace/issuer/derived identity
- [x] Contract, budget, lineage ID, and exact binding use the canonical parser
- [x] Shared attached-source metadata admits only closed create/cancel tuples
- [x] Cross-kind source/authority/command swaps fail closed
- [x] Schema 13 and the existing source table are reused unchanged
- [x] Source event, canonical lineage creation, and ledger share one transaction
- [x] Worker-thread mode uses one composite command and post-ACK projection
- [x] Restart replay creates no duplicate lineage
- [x] Changed evidence under one dispatch reference conflicts without overwrite
- [x] A different source for one lineage records/replays subject conflict
- [x] Forced source and ledger failures roll back every coupled write
- [x] Source table excludes raw dispatch reference, request, contract, operator
      identity, prompts, credentials, provider output, and production payloads
- [x] Existing operator-cancel and task lifecycle semantics remain unchanged
- [x] Default mode remains `off`; `enforce` remains unsupported
- [x] Automatic source coverage is exactly `2/5`
- [ ] Record-mode activation, deploy/restart/canary, and real-lineage collection
      receive separate explicit approval

## O. Third authenticated owner — review report (Phase 16)

- [x] Exact review-report route is the only new mutation path
- [x] Ed25519 worker registry authenticates every review-report submission
- [x] Dedicated review-report key scope fails closed when absent
- [x] Verified key owner, never JSON, supplies reviewer issuer
- [x] Canonical Phase 8 receipt parser proves issuer/reviewer equality
- [x] Request rejects missing, extra, authority, namespace, issuer, and derived
      identity fields
- [x] Phase 13 carrier authorization and Phase 12/8 admission remain canonical
- [x] Closed attached-source set is exactly create, review, and cancel
- [x] Correction generation and reviewer replacement remain detached
- [x] Source event, canonical lineage transition, and ledger share one
      transaction
- [x] Direct and worker-thread paths preserve replay/conflict and rollback
- [x] Worker-thread path uses one composite command and post-ACK projection
- [x] Off mode is inert before receipt parsing or store access
- [x] Minimized source metadata excludes report reference, reviewer, private
      prose, prompts, provider payloads, and credentials
- [x] Existing lineage-create and operator-cancel paths remain compatible
- [x] Generic task completion/result/log/prose and finalizer paths remain
      detached
- [x] Default mode remains `off`; `enforce` remains unsupported
- [x] Automatic source coverage is exactly `3/5`
- [ ] Live schema execution, record-mode activation, deploy/restart/canary,
      provider send, and real-lineage collection receive separate approval

## P. Fourth authenticated owner — correction generation (Phase 17)

- [x] Exact correction-generation route is the only new mutation path
- [x] Exact-role operator gate runs before trusted context construction
- [x] Request contains only generation reference, observed time,
      pre-correction binding, next head/diff, frozen intent, and changed paths
- [x] Request cannot select source, authority, namespace, issuer, operator,
      producer ID, or source-event ID
- [x] Trusted code assigns `correction_generation_committed` and semantic
      `correction_controller`
- [x] Phase 13 authorization and Phase 12/8 admission remain canonical
- [x] Schema 13 and the existing source table are reused unchanged
- [x] Closed attached-source set is exactly create, review, correction, cancel
- [x] Reviewer replacement remains detached
- [x] Admission outside `correction_pending` records a stable rejection without
      changing canonical lineage state or head
- [x] Exact-subject and frozen-intent mismatches fail closed
- [x] Forbidden and out-of-scope paths preserve the pending head
- [x] Source event, canonical lineage transition/outcome, and ledger share one
      transaction
- [x] Direct and worker-thread paths preserve replay/conflict and rollback
- [x] Worker-thread path uses one composite command and post-ACK projection
- [x] Off mode is inert before request parsing or store access
- [x] Minimized source metadata excludes generation reference, operator,
      changed paths, patch/fixer output, prompts, provider payloads, and
      credentials
- [x] Existing lineage-create, review-report, and operator-cancel paths remain
      compatible
- [x] Generic task/result/log/prose, completion, retry, finalizer, approval,
      and fixer paths remain detached
- [x] Default mode remains `off`; `enforce` remains unsupported
- [x] Automatic source coverage is exactly `4/5`
- [ ] Live schema execution, record-mode activation, deploy/restart/canary,
      provider send, ACK/replay/prune/migration, and real-lineage collection
      receive separate approval

## Q. Fifth authenticated owner — reviewer replacement (Phase 18)

- [x] Exact reviewer-replacement route is the only new mutation path
- [x] Exact-role operator gate runs before trusted context construction
- [x] Request contains only decision reference, observed time, and exact
      current intent/head/diff binding
- [x] Request cannot select reason, source, authority, namespace, issuer,
      operator/reviewer, producer ID, source-event ID, task, or assignment
- [x] Trusted code assigns `reviewer_replacement_decided`,
      `reviewer_allocator`, observation kind, and infrastructure-failure reason
- [x] Phase 13 authorization and Phase 12/8 admission remain canonical
- [x] Schema 13 and the existing source table are reused unchanged
- [x] Closed attached-source set is exactly all five source/authority/command/
      observation tuples
- [x] Exact-subject CAS and same-event changed-payload conflict fail closed
- [x] Already-terminal lineage admission is a stable rejection, not an applied
      no-op
- [x] Only the reviewer-replacement counter increments on a valid replacement
- [x] Shared budget, start time, head, diff, intent, reviewer-run count,
      correction-generation count, findings, and other counters are preserved
- [x] Replacement-budget exhaustion remains terminal and visible
- [x] Source event, canonical lineage transition/outcome, and ledger share one
      transaction
- [x] Direct and worker-thread paths preserve replay/conflict and rollback
- [x] Worker-thread path uses one composite command and post-ACK projection
- [x] Off mode is inert before request parsing or store access
- [x] Minimized source metadata excludes decision reference, operator/reviewer,
      task/assignment data, logs, prose, prompts, provider payloads, and
      credentials
- [x] Existing lineage-create, review-report, correction-generation, and
      operator-cancel paths remain compatible
- [x] No worker selection, task assignment, dispatch, inference, or automatic
      replacement loop is added
- [x] Generic task/result/error/log/prose, completion, retry, finalizer,
      approval, and fixer paths remain detached
- [x] Default mode remains `off`; `enforce` remains unsupported
- [x] Authoritative source attachment coverage is exactly `5/5`
- [ ] GitHub CI evidence, detached independent review, and finalizer closeout
      are recorded only after completion
- [ ] Live schema execution, record-mode activation, deploy/restart/canary,
      provider send, ACK/replay/prune/migration, and real-lineage collection
      receive separate approval
- [ ] Issue #1518 closeout receives separate evidence and authorization
