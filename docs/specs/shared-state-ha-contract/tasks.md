# Tasks: Shared-State and HA Contract

> **Status:** implementation backlog. Checked items include the completed
> documentation packet and the completed bounded Phase 1 contract/parser and
> keyspace/digest/time-evaluator/idempotency-registry/outbox-registry and
> observability-catalog/parser/projector slices, plus the first bounded Phase
> 2.1 lease/claim, Phase 2.2 `executeIdempotent`, Phase 2.3 outbox-ordering,
> Phase 2.4 restart-continuity, Phase 2.5 partition/unavailable injection,
> Phase 2.6 expiry-boundary, and Phase 2.7 claim-graph projection/rollback
> backend-neutral conformance harnesses exercised against clearly labeled
> test-only deterministic reference models.
> Phase 2.5 partition/unavailable injection is also complete as a
> backend-neutral slice after its route-level readiness assertion moved to
> Phase 4; the moved assertion remains unchecked there. Sections 2.1 through
> 2.7 are therefore complete, and the two remaining section 2 subsections are
> blocked by design rather than by omission: 2.8 depends on section 3, and 2.9
> depends on an operator-approved performance budget.
> SQLite/shared adapter implementations and their conformance,
> retention/prune execution, runtime health/endpoint and query integration,
> migration, and operational rollout remain unchecked.
> Refs #1504.

## 0. Spec-first packet

- [x] Define the four exact deployment grades and current support status.
- [x] Define all required properties for replay, rate limit, lease/claim,
  idempotency, outbox order, and the claim-graph read model.
- [x] Define `a2a.shared-state.storage/v1`.
- [x] Define startup/readiness and secret-safe reset-risk signals.
- [x] Define deterministic local concurrency/failure tests.
- [x] Define staged migration, cutover gates, rollback invariants, and separate
  live authorizations.
- [x] Reconcile the directly affected limitation/durability docs.
- [x] Obtain required approval for the packet.

Packet approval was given by the repository operator on 2026-08-22 KST and is
recorded by this change and on issue #1504.

Two things it does, stated separately because they are different:

1. It **retroactively covers** `plan.md` Phase 1 — the work filed here as
   sections 1 and 2 — which was built and merged in full while this item stayed
   unchecked. Thirteen commits touching `packages/broker/src/shared-state-*.ts`
   landed from `a54257d5` (#1696) through `1099aea2` (#1931) before the gate was
   reached. `plan.md` Phase 0 states that merge or local check success is not
   packet approval and does not authorize Phase 1, so the documented
   authorization order and the actual work order had diverged. That divergence
   is recorded on issue #1504 rather than erased by this checkbox.
2. It **authorizes** the next phase: section 3, the SQLite adapter. That is the
   first work in this issue that writes to a real store instead of a detached
   test-only reference model.

What it does not do: it grants none of the twenty-one separately authorized
live actions listed in `plan.md`, which remain individually gated and none of
which have been taken. `plan.md` also still requires every source and runtime
phase after Phase 0 to be a separately reviewed change, so section 3 proceeds
PR-first exactly as sections 1 and 2 did. Runtime integration and default
enablement stay off.

## 1. Contract/schema work

- [x] Add closed schemas/types for adapter metadata, capabilities, lifecycle,
  transaction commands/results, health, and readiness.
- [x] Pin namespace/key canonicalization and domain-separated digest vectors.
- [x] Pin adapter-controlled clock, stored time floor, skew tolerance, and
  exact expiry boundaries.
- [x] Register every idempotency namespace and retention version.
- [x] Register every outbox stream key and ordering scope.
- [x] Define bounded public/operator observability schemas and negative leak
  fixtures.
- [x] Add unknown-version/unknown-field/capability-downgrade rejection tests.

## 2. Deterministic conformance harness

Tests use seeded deterministic schedules, explicit barriers where concurrency
is exercised, isolated factory-created targets, bounded operation counts, and
no external network or production data. An injected fake clock is used only
where the scenario has time semantics; the Phase 2.3 slice has none, the
Phase 2.4 slice uses one fake clock for exact integer observations, and the
Phase 2.6 slice uses one fake clock advanced to exact `expiry-1`, `expiry`,
and `expiry+1` instants. The Phase 2.7 slice has no time semantics and uses no
clock.

Section numbers here are not `plan.md` phase numbers. Sections 2.1 through 2.7
are the deterministic-harness work of `plan.md` Phase 1 and are backend-neutral
throughout. Sections 2.8 and 2.9 are not: 2.8 corresponds to `plan.md` Phase 5,
which the plan places *after* its SQLite adapter phase, and 2.9 has no
`plan.md` counterpart at all. Both carry prerequisites recorded in their own
sections. Read those before assuming either can be started from here.

### 2.1 Claim/lease concurrency

- [x] Release 32 contenders at one barrier against one queued resource; assert
  exactly one claim and 31 conflicts.
- [x] Assert the winner receives one attempt and fence, and every later
  successful claim has a strictly greater fence.
- [x] Pause the old claimant, advance exactly through expiry, reclaim, then
  assert
  old renew/complete/checkpoint/release writes fail with `stale_fence`.
- [x] Inject failure before mutation, after task mutation, after audit/outbox
  append, and before commit; assert all-or-none state.
- [x] Preserve the test-only reference-model snapshot through close/reopen and
  assert a second simultaneous singleton owner fails closed.
- [ ] Repeat through a SQLite/shared adapter close/reopen and local
  child-process singleton ownership conflict.

The checked Phase 2.1 facts above are proved only by the backend-neutral
harness against its test-only deterministic reference model. The model is not
a production or conforming SQLite/shared backend, is not connected to broker
runtime, and does not complete adapter conformance.

### 2.2 Idempotency concurrency

- [x] Release exactly 64 same-key/same-fingerprint commands at one explicit
  barrier; assert one executed result, 63 replayed results, 64 identical
  original outcome digests, and exactly one reservation/domain
  mutation/outbox append/stable outcome in the test-only snapshot.
- [x] Race two same-key/different-fingerprint commands at one explicit
  barrier; accept either bounded seeded winner rank, assert one executed
  result and one `idempotency_conflict`, and assert one winner effect with no
  loser effect.
- [x] Inject `after_commit_before_response`; assert
  unavailable/`ambiguous_commit` after the full commit, then replay the
  original outcome through the same `executeIdempotent` command without a
  second mutation or outbox append.
- [x] Inject rollback after reservation, domain mutation, outbox staging, and
  outcome staging before commit; assert the exact empty baseline with no
  pending reservation, then assert the next clean command executes once.
- [x] Execute once, close/reopen the same detached test target after an exact
  fake-clock advance, and assert the identical replayed outcome and snapshot
  continuity under `non_expiring_until_prune_proof` without executing
  retention or prune.
- [ ] Repeat the Phase 2.2 harness through SQLite/shared adapters and
  separately prove authorized retention/prune behavior.

The checked Phase 2.2 facts above are proved only by the backend-neutral
harness against its isolated, in-memory, test-only deterministic reference
model. The model is explicitly non-production, non-SQLite, non-shared,
non-conforming, detached from broker runtime, and makes no durable adapter
claim. Retention/prune execution remains unimplemented and untested.

### 2.3 Outbox ordering

- [x] Release exactly eight deterministic producers at an explicit promise
  barrier across exactly two distinct registered `broker.terminal-outbox`
  stream keys, four producers per stream.
- [x] Assert adapter-allocated sequences are unique and strictly increasing
  in adapter serialization/sequence order within each exact stream, report
  seeded producer schedule rank only for attribution with no caller-fairness
  assertion, use the existing same/different-stream ordering evaluator
  decisions, and make no global cross-stream ordering assertion.
- [x] Retry one committed same-idempotency-key/same-payload append; assert the
  `replayed` decision returns the original event-key digest and stream
  sequence, creates no second domain/event effect, and receives the existing
  retry evaluator's `original-binding` decision.
- [x] Inject exact `domain-before-append` and `append-before-commit` faults;
  assert unavailable/`authority_unavailable`, the exact empty baseline, and
  then one domain effect plus one outbox event on a clean retry.
- [x] Confirm one receipt with `current-session-visible` evidence, inject
  `ack-before-commit`, assert the confirmed event remains unacknowledged, then
  assert `acknowledged` and `already_acknowledged` on two clean retries
  without a duplicate effect.
- [x] Close/reopen one detached target and use only the explicitly labeled
  test-only reconciliation control with start, intermediate per-stream, and
  end cursors; assert no per-stream reversal, no duplicate event ID in one
  response, unacknowledged replay, no acknowledged replay beyond the model's
  acknowledged-through cursor, and preserved receipt/ACK state without a
  global cursor-order assertion.
- [x] Preserve `pending`/`unacknowledged` after provider-accepted receipt
  evidence, and assert the existing pure policy evaluator and storage V1
  parser reject a provider-accepted ACK attempt as
  `provider_acceptance_not_ack` /
  `outbox_provider_acceptance_not_ack`.
- [ ] Repeat the Phase 2.3 harness through SQLite/shared adapters and
  separately implement/prove any authorized query/reconciliation and
  retention/prune behavior.

The checked Phase 2.3 facts above are proved with 30 existing storage V1
commands, three bounded test-only reconciliation controls, one parser/policy
negative attempt, seven isolated targets, and a 40-operation ceiling. The
reference model is in-memory, test-only, non-production, non-SQLite,
non-shared, non-conforming, detached from broker runtime, and makes no durable
adapter claim. Its reconciliation seam is not a V1 storage query or runtime
API. Runtime/query integration, real ACK/replay/prune, and retention execution
remain unimplemented and untested.

### 2.4 Restart continuity

- [x] On one fresh detached target at one exact fake-clock instant, commit an
  unexpired replay nonce, in-window rate cost, active lease/attempt/fence, one
  registered `executeIdempotent` domain/outbox outcome, three retained outbox
  events across two streams with sequences `1,2` and `1`, two
  receipt-confirmed/acknowledged events, one pending/unacknowledged replay
  event, one test-only cursor, two graph source facts, and projection
  checkpoint `2`.
- [x] Close, advance the one injected fake clock by exactly 100 milliseconds
  against 1,000-millisecond replay/rate/lease boundaries, reopen the same
  detached target, and assert replay, `rate_limited`, original
  owner/attempt/fence renew and fenced mutation, original idempotency outcome
  without duplicate effects, original append bindings, exactly one
  test-control reconciliation replay with preserved receipt/ACK state, and
  original graph source sequences/checkpoint.
- [x] On four isolated factory-created targets, inject exact
  `before-command-commit`, `after-command-commit-before-response`,
  `before-ack-commit`, and `after-ack-commit-before-response` crash points.
  Assert the existing unavailable vocabulary reports
  `authority_unavailable` before commit and `ambiguous_commit` after commit;
  reopen to the exact empty/pre-ACK or committed state; then assert clean
  retry resolves once as `executed`, `replayed`, `acknowledged`, or
  `already_acknowledged` with no second effect.
- [x] On one isolated prepared target, retain the test-model clock floor,
  reopen with the observed fake-clock value exactly one millisecond beyond
  the declared backward-skew tolerance, and assert the existing time V1
  evaluator returns `backward_beyond_tolerance`, not-ready, writes/logical
  decisions forbidden, lifecycle `failed` with only `unsafe_clock`, an
  unavailable/`unsafe_clock` attempted write, and an unchanged aggregate
  snapshot. Restore observation at the retained floor and reopen ready with
  the same state.
- [x] Across every close/reopen and crash-recovery comparison, assert the
  maximum fencing token, lease resource-version high-water, every retained
  per-stream sequence high-water, graph source sequence, and graph projection
  checkpoint never decrease.
- [x] Keep all snapshot, crash, cursor, and reconciliation seams explicitly
  labeled bounded test-only conformance controls; keep strict reports,
  snapshots, controls, and errors closed, aggregate-only, and non-reflecting.
- [ ] Repeat the exact Phase 2.4 harness through SQLite/shared adapters and
  separately prove real durability, adapter clock-floor persistence, and any
  separately authorized runtime/query reconciliation or retention/prune
  behavior.

The checked Phase 2.4 facts above use 45 existing storage V1 commands, 21
existing lifecycle transitions, 19 bounded aggregate snapshot controls, four
crash-fault controls, two cursor/reconciliation controls, three exact
fake-clock controls, six isolated targets, and a 64-command ceiling. The
adjacent reference model is in-memory, test-only, non-production, non-SQLite,
non-shared, non-conforming, and detached from broker runtime. Its
close/reopen object-state retention is a conformance control, not a durability
claim. Its snapshot/cursor/reconciliation/crash seams are not V1 adapter,
query, clock, health, readiness, storage, or runtime APIs. Actual adapter
persistence and conformance, runtime/query integration, real ACK/replay/prune,
retention execution, migration, deployment, live rollout, and overall issue
completion remain unimplemented and unchecked.

### 2.5 Partition/unavailable injection

- [x] Wrap the adapter with deterministic unavailable, timeout,
  ambiguous-commit, lost-fence, and delayed-read fault points. The existing
  harnesses already exercise `authority_unavailable`, `ambiguous_commit`,
  `unsafe_clock`, and `lost_ownership`; `lock_timeout` and delayed-read have
  no existing coverage and are the real work here.
- [x] Assert replay/rate protected requests return unavailable, never an empty
  local decision.
- [x] Assert claims/renewals/completions and idempotent mutations do not apply
  while authority is unavailable.
- [x] Assert outbox producer transaction fails atomically; consumer may replay
  but cannot ACK/prune while partitioned.
- [x] Assert a partitioned graph query serves an explicitly stale result with
  checkpoint and lag. Phase 2.7 already proves the
  `projection_incomplete`/`projection_unavailable`/`no_evidence_path`
  distinction and the complete-checkpoint rule for negative evidence, so this
  item covers only the stale-result case and must not reimplement them.
- [x] Assert the adapter lifecycle reports not-ready with the closed
  readiness/lifecycle reason vocabulary while the authority is unavailable,
  and that no state mutation applies in that state.

- [ ] Repeat the Phase 2.5 fault matrix through SQLite/shared adapters and
  separately prove real partition behavior against a live authority.

The checked Phase 2.5 facts above use 18 existing storage V1 commands, 10
existing lifecycle transitions, 14 bounded aggregate snapshot controls, 14
fault controls, two bounded stale-read controls, two bounded adapter-lifecycle
readiness controls, five isolated targets, and a 64-command ceiling. The four
write fault points are checked at module load against the closed
`unavailableReasonCodes`, so a later vocabulary addition fails closed rather
than silently under-covering; `unsafe_clock` is deliberately the one closed
reason not driven by partition injection, because Phase 2.4 proves it through
the time contract instead. `lock_timeout` and delayed-read had no prior
coverage anywhere in the repository and are proved here for the first time.
The reference model is in-memory, test-only, non-production, non-SQLite,
non-shared, non-conforming, detached from broker runtime, and makes no durable
adapter claim.

The readiness item is proved at the adapter-lifecycle layer only. The harness
additionally checks, rather than asserts, the two-layer claim that justified
the boundary move: every lifecycle fault reason has an exact
`readinessReasonCodes` counterpart (eight codes), and the only lifecycle-only
codes are normal transitions. `/readyz`, the non-serving middleware, and any
route status remain Phase 4 and are not proved here.

Phase 2.5 is backend-neutral in full. The route-level readiness assertion that
previously sat here moved to Phase 4, because `/readyz` and the non-serving
middleware are Phase 4 deliverables that do not exist yet: `spec.md` section
7.2 calls the endpoint *planned*, and no `/readyz` route exists in broker
source. Asserting route behavior from Phase 2 therefore had an inverted
dependency on a later phase, which is why this section could not be started as
written. The backend-neutral readiness item above is the part Phase 2 can
actually prove: the same facts are already expressed at the adapter-lifecycle
layer, and Phase 2.4 proved one of them (`unsafe_clock` producing lifecycle
`failed` with writes forbidden).

### 2.6 Expiry boundaries

- [x] For replay, rate cost, lease, and allowed idempotency-retention fixtures,
  test `expiry-1`, `expiry`, and `expiry+1` with the fake clock.
- [x] Assert physical cleanup delay never changes logical decisions.
- [x] Assert capacity pressure never evicts unexpired replay/idempotency
  safety records permissively.
- [x] Assert lease expiry requires an atomic ownership transition and advances
  the fence.
- [x] Assert unacknowledged outbox and claim provenance have no implicit TTL.
- [ ] Repeat the Phase 2.6 boundary matrix through SQLite/shared adapters and
  separately prove authorized retention/prune execution at and after the
  logical boundary.

The checked Phase 2.6 facts above use one injected fake clock advanced through
three exact instants, four closed boundary fixtures probed at each instant for
twelve total probe cases, 44 existing storage V1 commands, 14 existing
lifecycle transitions, 11 bounded aggregate snapshot controls, two
physical-cleanup controls, one capacity-pressure control, six exact fake-clock
controls, seven isolated targets, and a 64-command ceiling. The declared
fixture list is checked against the closed time V1 boundary vocabulary at
module load, so a later vocabulary addition fails closed instead of silently
under-covering. The reference model is in-memory, test-only, non-production,
non-SQLite, non-shared, non-conforming, detached from broker runtime, and
makes no durable adapter claim. It deliberately retains physically expired
rows so the slice can prove that presence is not an input to a logical
decision; that retention is a conformance control, not a durability or
retention-policy claim.

Two boundary facts are proved only against pure evaluators rather than a
registered runtime policy. No V1 idempotency namespace is currently registered
as `time-bounded`, so the allowed idempotency-retention fixture uses an
explicitly labeled test-only registration passed directly to the existing
expiry evaluator; every registered namespace is separately asserted to remain
`non-expiring-until-prune-proof`. Retention and prune are never executed, so a
logically expired retention boundary is asserted to leave the retained outcome
replayable rather than deleted. Partition/unavailable injection and readiness
route behavior remain out of scope and unchecked in section 2.5.

### 2.7 Claim-graph projection and rollback

- [x] Append typed `Entity`, `Claim`, `Source`, `Artifact`, `AgentRun`, and
  `Evaluation` source fixtures with provenance.
- [x] Project one batch atomically and answer a cross-task evidence-path query
  using graph/source references only.
- [x] Pause projection behind source high-water and assert incomplete result,
  lag, and checkpoint.
- [x] Inject failure between node/edge writes and checkpoint; assert checkpoint
  does not advance.
- [x] Inject a false merge, apply its recorded inverse/tombstone batch, and
  assert the prior complete graph is restored while immutable sources remain.
- [x] Reapply the same batch/rollback and assert idempotent results.
- [ ] Repeat the Phase 2.7 projection/rollback matrix through SQLite/shared
  adapters and separately implement and prove a real graph query surface.

The checked Phase 2.7 facts above use 31 existing storage V1 commands, six
existing lifecycle transitions, 10 bounded aggregate snapshot controls, one
projection-fault control, six bounded evidence-path controls, three isolated
targets, and a 48-command ceiling. The six typed source fixtures are checked
against the closed `graphNodeTypes` vocabulary at module load, so a later
vocabulary addition fails closed instead of silently under-covering. The
reference model is in-memory, test-only, non-production, non-SQLite,
non-shared, non-conforming, detached from broker runtime, and makes no durable
adapter claim.

Two boundaries deserve explicit statement. **V1 registers no query operation**,
so the cross-task evidence-path answer is produced by a bounded test-only
conformance control, not by a storage query contract; the four results
`path_found`, `no_evidence_path`, `projection_incomplete`, and
`projection_unavailable` are named by spec section 5.6 and are declared as
harness-owned vocabulary rather than added to the storage contract. And
because rolling a batch back necessarily leaves the checkpoint behind the
source high-water, the restored query returns `projection_incomplete` rather
than a negative judgment — the harness separately asserts that
`no_evidence_path` is only ever returned at a complete checkpoint, matching
`negativeEvidenceRequires=complete-checkpoint`.

### 2.8 Migration/rollback rehearsal

**Prerequisite: section 3.** This section is `plan.md` Phase 5
("Local/offline migration rehearsal"), which the plan places after its
Phase 2 SQLite single-writer adapter — the work filed here as section 3. The
first item below imports into SQLite V1, so it needs V1 tables and migrations
to exist; none do today. Section 3 is in turn gated on the unchecked
`Obtain required approval for the packet` item in section 0, which is an
operator decision.

Its section number therefore sits inside the deterministic-harness block while
its dependency sits after it. That ordering is deliberate in `plan.md` and is
recorded here only so the section is not mistaken for startable
backend-neutral work. Nothing in this section is re-scoped by that note.

- [ ] Import a versioned local legacy fixture into SQLite V1 and compare
  redacted canonical digests/counts.
- [ ] Shadow/dual-read a deterministic trace with legacy responses
  authoritative; inject one mismatch and assert cutover blocks.
- [ ] Rehearse final delta/cutover with a crash at every boundary.
- [ ] Rehearse rollback with unexpired security state, active fence,
  idempotency outcome, unacknowledged outbox, ACKed outbox, and graph
  checkpoint.
- [ ] Assert rollback refuses when the prior format cannot represent a
  committed post-cutover state.
- [ ] Assert no test sends, ACKs, prunes, deploys, provisions, or reaches an
  external service.

### 2.9 Bounded local performance characterization

**Prerequisite: an operator-approved budget.** This section has no `plan.md`
counterpart — the plan defines no performance phase — and its fourth item
states its own gate: do not invent a pass threshold until Phase 1 records the
workload and an operator approves the budget. Measurement without that
approval would produce numbers with no accepted meaning, so this section is
not startable on its own either.

- [ ] Use fixed fixture sizes, seeded operation order, injected clock, one
  warm-up, and a bounded sample count; record machine/runtime metadata without
  host-specific paths or identities.
- [ ] Measure replay consume, rate reservation, uncontended/contended claim,
  idempotent first/replay/conflict, outbox append/read, and graph projection
  batch/query separately.
- [ ] Record throughput, p50/p95/p99 latency, SQLite busy/queue counts, storage
  growth, and cleanup cost for inline and optional worker-writer modes.
- [ ] Compare against a pinned local legacy baseline and classify regressions;
  do not invent a pass threshold until Phase 1 records the workload and an
  operator approves the budget.
- [ ] Inject the same bounded unavailable/rollback faults during load and
  assert correctness invariants before considering performance numbers.
- [ ] Treat local results as characterization only, not production capacity or
  HA evidence.

## 3. SQLite adapter implementation

- [ ] Add V1 tables/migrations only in a separately reviewed source PR.
- [ ] Add exclusive singleton ownership and monotonic lifecycle epoch.
- [ ] Implement all primitives with `BEGIN IMMEDIATE` atomic boundaries.
- [ ] Prove inline writer conformance.
- [ ] Prove optional FIFO worker writer conformance and durable ACK behavior.
- [ ] Ensure synchronous reads declare/bound consistency and cannot observe an
  unacknowledged write as committed.
- [ ] Preserve existing export/inspection and fail-safe recovery behavior.
- [ ] Keep runtime integration/default enablement off.

## 4. Startup/readiness/runtime integration

- [ ] Add exact grade and expected-process configuration.
- [ ] Add startup version/capability/clock/schema/migration checks.
- [ ] Add fenced singleton ownership and loss monitoring.
- [ ] Add `/readyz` and state-authority non-serving middleware.
- [ ] Assert `/readyz` becomes false and non-liveness routes stop serving
  while `/livez` remains liveness-only. Moved here from section 2.5: the
  assertion needs the middleware above, so it cannot be proved by a
  backend-neutral Phase 2 harness.
- [ ] Add secret-safe `stateContract` health without identity-bearing top-key
  data.
- [ ] Add volatile replay/rate reset-risk epoch/reason signals.
- [ ] Make `shared-state-ha` fail until an approved conforming backend exists.
- [ ] Integrate primitives one at a time behind default-off flags.
- [ ] Run compatibility/regression/performance tests.

## 5. Migration and operations

- [ ] Obtain authorization for production backup/read.
- [ ] Obtain authorization for schema migration/backfill.
- [ ] Obtain authorization for live shadow/dual-read or equivalent validation.
- [ ] Meet every SQLite cutover gate.
- [ ] Obtain exact deploy/restart/drain/traffic cutover authorization.
- [ ] Execute and validate cutover.
- [ ] Observe the approved rollback window without invariant breach.
- [ ] Obtain separate rollback authorization if triggered.

## 6. Future shared-state HA

- [ ] Select/design a shared backend separately.
- [ ] Prove every V1 guarantee and privacy boundary.
- [ ] Prove multi-process, partition, failover, restart, and clock behavior.
- [ ] Obtain provisioning/credential/network authorization.
- [ ] Complete shadow/journal validation with SQLite remaining canonical.
- [ ] Meet every HA cutover gate.
- [ ] Obtain exact replica increase/traffic/failover authorization.
- [ ] Promote `shared-state-ha`.

## 7. Validation commands by phase

Documentation phase:

```bash
npm run check:markdown-links
npm run check:ci-docs-safety
npm run scan:public-readiness
npm run scan:external-secrets
git diff --check
```

Phase 2.1 source slice:

```bash
npm run build --workspace=a2a-broker
node --test packages/broker/dist/shared-state-lease-conformance-v1.test.js
npm test --workspace=a2a-broker
npm run check
npm run scan:public-readiness
npm run scan:external-secrets
npm run check:markdown-links
git diff --check
```

The focused command proves the harness/reference-model slice only. It is not
an adapter, migration, runtime integration, deployment, or full-conformance
gate.

Phase 2.2 source slice:

```bash
npm run build --workspace=a2a-broker
node --test packages/broker/dist/shared-state-idempotency-conformance-v1.test.js
npm test --workspace=a2a-broker
npm run check
npm run scan:public-readiness
npm run scan:external-secrets
npm run check:markdown-links
git diff --check
```

The focused Phase 2.2 command proves only the backend-neutral harness against
the detached test-only reference model. SQLite/shared adapter conformance,
runtime integration, retention/prune execution, migration, deployment, live
rollout, and overall issue completion remain open.

Phase 2.3 source slice:

```bash
npm run build --workspace=a2a-broker
node --test packages/broker/dist/shared-state-outbox-conformance-v1.test.js
npm test --workspace=a2a-broker
npm run check
npm run scan:public-readiness
npm run scan:external-secrets
npm run check:markdown-links
git diff --check
```

The focused Phase 2.3 command proves only the backend-neutral harness against
the adjacent detached test-only reference model. SQLite/shared adapter
conformance, runtime/query integration, retention/prune execution, migration,
deployment, live rollout, and overall issue completion remain open.

Phase 2.4 source slice:

```bash
npm run build --workspace=a2a-broker
node --test packages/broker/dist/shared-state-restart-continuity-conformance-v1.test.js
npm test --workspace=a2a-broker
npm run check
npm run scan:public-readiness
npm run scan:external-secrets
npm run check:markdown-links
git diff --check
```

The focused Phase 2.4 command proves only the backend-neutral
restart-continuity harness against the adjacent detached test-only reference
model. Test-object close/reopen retention is not a durability claim.
SQLite/shared adapter persistence or conformance, runtime/query integration,
retention/prune execution, migration, deployment, live rollout, and overall
issue completion remain open.

Phase 2.6 source slice:

```bash
npm run build --workspace=a2a-broker
node --test packages/broker/dist/shared-state-expiry-conformance-v1.test.js
npm test --workspace=a2a-broker
npm run check
npm run scan:public-readiness
npm run scan:external-secrets
npm run check:markdown-links
git diff --check
```

The focused Phase 2.6 command proves only the backend-neutral expiry-boundary
harness against the detached test-only reference model. The test model's
retention of physically expired rows is a conformance control, not a
durability or retention-policy claim, and the allowed time-bounded retention
posture is exercised only through a test-only registration that is never added
to the closed catalog. SQLite/shared adapter conformance, runtime integration,
retention/prune execution, partition/unavailable injection, readiness route
behavior, migration, deployment, live rollout, and overall issue completion
remain out of scope.

Phase 2.7 source slice:

```bash
npm run build --workspace=a2a-broker
node --test packages/broker/dist/shared-state-claim-graph-conformance-v1.test.js
npm test --workspace=a2a-broker
npm run check
npm run scan:public-readiness
npm run scan:external-secrets
npm run check:markdown-links
git diff --check
```

The focused Phase 2.7 command proves only the backend-neutral claim-graph
projection and rollback harness against the detached test-only reference
model. Its evidence-path seam is a conformance control and not a V1 storage
query, runtime API, or graph service. SQLite/shared adapter conformance, a
real query surface, runtime integration, retention/prune execution,
partition/unavailable injection, readiness route behavior, migration,
deployment, live rollout, and overall issue completion remain out of scope.

Phase 2.5 source slice:

```bash
npm run build --workspace=a2a-broker
node --test packages/broker/dist/shared-state-partition-conformance-v1.test.js
npm test --workspace=a2a-broker
npm run check
npm run scan:public-readiness
npm run scan:external-secrets
npm run check:markdown-links
git diff --check
```

The focused Phase 2.5 command proves only the backend-neutral partition and
unavailable-injection harness against the detached test-only reference model.
Its readiness control reports the adapter-lifecycle view and is not `/readyz`,
middleware, or a route contract; its stale-read control is not a V1 storage
query. SQLite/shared adapter conformance, real partition behavior against a
live authority, runtime integration, retention/prune execution, readiness
route behavior, migration, deployment, live rollout, and overall issue
completion remain out of scope.
