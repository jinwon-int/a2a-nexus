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

The same harness has since been run against a real V1 SQLite adapter target,
described in section 3. That run proves the matrix through SQLite, which is the
first clause of the repeat item above; the item stays unchecked because its
second clause — separately proving authorized retention/prune behavior — is
neither this work nor an adapter decision.

It is also the first target to use the recorded fault-point collapse decision,
and the collapse is worth stating here rather than only in the target. V1
performs no reservation and executes no domain mutation of its own, so
`after_reservation` and `after_domain_mutation` name the same instant — nothing
durable written yet — and map to the same statement. The remaining two points
map to the outcome write and to the commit. Four armed points, three real
positions, declared rather than fabricated.

The same collapse reaches the snapshot counters, which extends the decision
from fault points to counts. V1 keeps one durable record per executed effect,
so `reservationCount`, `domainMutationCount`, and `stableOutcomeCount` are all
derived from the idempotency row and `outboxAppendCount` from the link row
staged in the same transaction. The counts still answer what the harness asks —
whether exactly one effect happened — but they are not four independent
observations. `pendingReservationCount` is the one counter whose zero is real
rather than collapsed, because V1 has no reservation to leave pending.

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
  <!-- The SQLite half of this item is done: the Phase 2.3 harness runs
  against the V1 SQLite adapter in
  `packages/broker/src/shared-state-sqlite-outbox-target-v1.test.ts`. The item
  stays unchecked for the second clause only — authorized query and
  reconciliation, and retention and prune, are separate work and not adapter
  decisions. The reconciliation used by that target is a bounded test-only
  control, explicitly not a V1 query surface. -->

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

The same harness has since been run a second time against a real V1 SQLite
adapter target, described in section 3. That run proves the matrix through
SQLite, which is the first clause of the repeat item above. The item stays
unchecked because its second clause is separate work: it requires a real graph
query surface, and V1 registers no query operation, so the evidence-path answer
is still produced by the bounded test-only control named earlier in this
section. The unchecked box should be read as "no query surface", not as "no
SQLite evidence".

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

The V1 schema lives in its own database file, separate from the legacy
`broker_*` store. That is required rather than stylistic: section 6.2 of
`spec.md` forbids nested or cross-adapter transactions, section 6.3 states the
contract does not imply that a generic existing SQLite store already conforms,
and the closed vocabulary keeps `legacy-sqlite` and `sqlite-single-writer` as
distinct backend classes. Measured on Node v22.22.2 `node:sqlite`, sharing the
legacy connection is impossible (a nested `BEGIN IMMEDIATE` raises `cannot
start a transaction within a transaction`) and sharing the legacy file makes
the two writers block each other (`database is locked` at the default
`busy_timeout=0`). The V1 schema therefore carries its own version axis rather
than advancing the legacy store's `SQLITE_SCHEMA_VERSION`.

- [x] Add V1 tables/migrations only in a separately reviewed source PR.
- [x] Add exclusive singleton ownership and monotonic lifecycle epoch.
- [x] Implement all primitives with `BEGIN IMMEDIATE` atomic boundaries.
- [x] Prove inline writer conformance.
- [ ] Prove optional FIFO worker writer conformance and durable ACK behavior.
- [ ] Ensure synchronous reads declare/bound consistency and cannot observe an
  unacknowledged write as committed.
- [ ] Preserve existing export/inspection and fail-safe recovery behavior.
- [ ] Keep runtime integration/default enablement off.

### Slice F, first part — the idempotency effect's outbox link

Two owner decisions settled the question slice F was blocked on, and both are
recorded here because each changes what a later reader should expect.

**Decision 1 — the effect's outbox block is a caller-owned link, stored in its
own table.** Nothing reads its four values: the Phase 2.2 reference model
increments a counter, the harness asserts that counter is one, and neither
outcome digest nor this adapter binds any of the fields. But the harness
requires something staged in the transaction, and section 5.4.1 says the outbox
operations are not aliases for `executeIdempotent`. The schemas agree — the
effect's `retentionPolicyVersion` is a shape-only string while
`appendOutbox.retentionPolicyVersion` is the closed section 5.5.1 registry — so
a block that cannot name a registered policy is not describing a registered
row. `shared_state_idempotency_outbox_link` records the four values exactly as
supplied. Nothing is derived, defaulted, or invented.

A separate table rather than columns, and that part was measured rather than
argued. `CREATE TABLE IF NOT EXISTS` skips the entire statement when the table
exists, so columns added to `shared_state_idempotency` never reach a database
already in use — while a new table is created on that same database normally.
Worse, schema validation checks table names and not columns, so the added-column
shape reports `ok` and fails at the first write instead. Raising the schema
version does not rescue it: that rejects the database outright. The table count
goes from eleven to twelve, which is the whole cost.

The link is staged **before** the outcome row, in the same `BEGIN IMMEDIATE`
boundary, because that is the order the Phase 2.2 fault matrix names — outbox
staging precedes outcome staging. A test fails the outcome write through a
proxied database handle and asserts both rows are gone, and asserts the link
statement was prepared first, because a failure landing before the link write
would leave the same empty table and prove nothing.

**Decision 2 — a target may declare a fault-point collapse.** The Phase 2.2
harness arms four in-transaction fault points; V1 performs no reservation and
executes no domain mutation of its own, so `after_reservation` and
`after_domain_mutation` name the same instant — nothing durable written yet.
Phase 2.1 collapses at the other end, where nothing is written between audit and
outbox staging and the commit. A SQLite target may map such a point onto the
nearest real boundary and **state the collapse in its report**; it may not
fabricate a boundary, and the adapter may not grow a durable write with no
effect behind it purely to create one.

The consequence is worth stating plainly rather than discovering later: a repeat
item checked under this decision proves all-or-none **at every boundary V1
actually has**, not at every boundary the reference model models.

### Slice H — declared synthesis

**Decision 3 — a target may synthesize a value or lifecycle state V1 does not
have, provided it declares it.** This is a different category from decision 2
and the difference is the reason it needed deciding separately. Decision 2 maps
a fault point onto the nearest *real* boundary: something exists to map onto.
The Phase 2.4 and 2.5 harnesses instead ask for three things V1 has no
counterpart for at all, so there is nothing to map and the target must either
produce the value itself or the section cannot be driven.

A target may therefore synthesize, under three conditions: the frozen
descriptor **lists** every synthesized value, a test **asserts** that list, and
the synthesis is **cut as narrowly as possible so it does not mask evidence the
adapter can genuinely produce**. The third condition is the operative one, and
the backward-clock case below shows what it buys.

The three cases, each measured rather than argued:

`leaseMutationCount` has no durable source. `shared_state_lease` carries seven
columns and none of them counts mutations or stores a mutation digest;
`mutateWithFence` writes `resource_version` and nothing else. Deriving the count
from `resource_version` is wrong arithmetic — a claim, a renewal, and one
mutation leave version three and mutation count one. It is therefore a declared
constant zero. This is the exact inverse of the Phase 2.3 target's
`receiptFailedCount`, which that descriptor was careful to record as a real
query that returns zero rather than a hard-coded value, so the two must be
listed in different buckets and not confused by a later reader.

The Phase 2.4 backward-clock scenario requires `open()` to answer `failed` with
`unsafe_clock`. V1 evaluates time in exactly one place — inside `transact` —
and `open()` validates schema, ownership, clock profile, and epoch without ever
consulting the clock; its `failed` envelope carries `adapter_unavailable`.
Rather than synthesize the whole scenario, the target opens the adapter **for
real** and synthesizes only the lifecycle envelope, leaving the adapter open.
The forbidden write the harness issues next then reaches `transact`, whose own
time evaluation produces a real rollback, a real `unsafe_clock` unavailable
envelope, and a real `failed` state — so the unchanged-snapshot assertions are
genuine rollback evidence. Two of the scenario's three facts stay real and the
declaration narrows to one sentence: the adapter is open while the target
reports failed, because V1 `open()` evaluates no clock.

The Phase 2.5 readiness envelope has no adapter surface behind it at all — the
adapter exposes eight members and readiness is not among them — so the target
constructs it. The adapter's `failed` lifecycle reason is `adapter_unavailable`,
which is already exactly what that section asserts, so only the readiness half
is synthesized.

The consequence, stated plainly for the same reason decision 2 states its own: a
repeat item checked under this decision proves **what V1 actually has, plus the
synthesis it declares** — not every fact the reference model models. A reader
comparing the harness to the target should expect the descriptor's synthesis
list to account for the difference, and should treat an undeclared gap as a
defect rather than an instance of this decision.

Slice H, first part, drives the Phase 2.4 harness through the adapter in
`packages/broker/src/shared-state-sqlite-restart-continuity-target-v1.test.ts`.
It is the first target whose close and reopen are a real restart: the database
is a file, the adapter is handed a `DatabaseSync` rather than owning one, and
`close`/`open` release and re-acquire ownership against that same file. The
three earlier targets already used file-backed databases, so what is new here
is not the file but that continuity across a close is the thing under test.

No fault point collapses. Two of the four are statement faults in different
commands — `before-command-commit` at the outbox link INSERT, which is
`executeIdempotent`'s first durable write, and `before-ack-commit` at the
acknowledgment transaction's COMMIT. The other two are deliberately not
statement faults at all: the transaction has to commit for the answer to be
ambiguous, which is the shape Phase 2.2 established. A test asserts exactly two
statement faults fire, and at which statement kinds, so the matrix cannot pass
because nothing ran.

Three measured facts shaped the target and none of them was predictable from
the earlier slices. The adapter must be constructed with the harness's own
backward-skew tolerance rather than the `"0"` the three earlier targets pass,
because the backward-clock scenario observes exactly one millisecond beyond it.
The injected instant must be passed through verbatim rather than replaced by a
target-owned counter as Phase 2.3 does, because the adapter derives
`expiresInMs` and `resetInMs` from it and the harness asserts both are 900.
And after a crash fault the harness reopens with no close of its own, so the
target takes the adapter down itself — a fault leaves the adapter `ready` and a
bare reopen would answer `already_open`. For the same reason `close` branches on
adapter state: `drain` refuses anything that is not `ready`, and the adapter is
`failed` after the forbidden write.

Seventeen of the nineteen snapshot fields are real queries. `domainEffectCount`
is collapsed onto the idempotency row exactly as Phase 2.2 and 2.3 declared;
`idempotentOutboxEffectCount` is not collapsed with it, because the outbox link
is its own table and its own row. `leaseMutationCount` is the declared constant
above. Fencing tokens and sequences are compared as integers rather than by SQL
`MAX()`, which sorts TEXT lexically and would rank `"9"` above `"10"` — the same
trap the adapter documents against itself.

One adversarial control did not reach the check it exists to fail on its first
form, which is now the seventh time this section has caught that. Dropping the
reconciliation cursor's floor alone changed nothing, because at the point the
harness reconciles, the only event above the floor is also the only
unacknowledged one; the control had to drop the acknowledgment filter as well
before it could return a wrong answer.

The Phase 2.4 repeat item stays unchecked, for the same reason the three
earlier ones do: it also requires separately proving authorized runtime/query
reconciliation and retention/prune behaviour, which no slice has performed.

Slice H, second part, drives the Phase 2.5 harness through the adapter in
`packages/broker/src/shared-state-sqlite-partition-target-v1.test.ts`. It is
the fifth section to run on the real adapter and the first to prove
`lock_timeout` as anything other than vocabulary.

That is this slice's actual contribution and it is worth stating narrowly. The
in-memory reference target never injects a lock at all — it returns the mapped
reason from a table — so before this slice the checked item above covered
`lock_timeout` at the level of the name. Here the fault is a second
`DatabaseSync` on the same file holding a RESERVED lock through
`BEGIN IMMEDIATE`, and the adapter's own `BEGIN IMMEDIATE` collides with it.
Measured: the collision raises `SQLITE_BUSY` after zero milliseconds, because
the adapter's `busy_timeout` is zero — so the proof needs no timer and stays
deterministic. The adapter reports `store_failure` with `began` still false, so
it never reaches a ROLLBACK and never writes, and it stays `ready`, which is
what makes `lock_timeout` the honest reason rather than `authority_unavailable`.
Two further measurements shaped the fixture: reads succeed while the lock is
held, so the snapshot control can observe state with a fault armed; and a
nested `BEGIN IMMEDIATE` on the same connection raises `cannot start a
transaction within a transaction` instead, so the competing lock must be a
separate connection or it proves nothing.

The fault switch is level-triggered, which is the one structural break from all
four earlier targets and the only place copying them fails outright. The
harness arms `unavailable` once and then requires four separate commands to be
refused, while every earlier target consumes its arm on the first firing; it
also disarms explicitly with `null`, which no earlier harness does. So
`armConformanceFault` heals whatever the previous point established and then
installs the new one, and the point stays installed until the next arm. The
heal is required rather than tidy: the seeded order ends scenario A on
`lost-fence` and scenario B arms `unavailable` with no disarm between them, so
without it the adapter would still be `failed` and every later command would be
refused `not_ready` — a real refusal, which must never be dressed up as an
injected fault.

One pair of fault points collapses under decision 2. `unavailable` and
`lost-fence` rest on two different durable premises — a foreign `owner_token`
and a `lifecycle_epoch` the session never acquired — but `beginWrite` reaches
both through one branch and reports both as `ownership_lost`. Two durable
premises, one adapter code path; the reasons stay distinct because the target
knows which premise it wrote, not because the adapter distinguishes them. The
premise is re-established per command rather than left to the failed state the
previous command produced, so each refusal in a run is a fresh ownership check
inside the adapter rather than a cached verdict.

The readiness envelope is the decision 3 case the passage above anticipated,
and it is cut to the width that decision requires. `lifecycleState` and
`lifecycleReasonCodes` are the adapter's real `lifecycle()` output; only the
`ready` boolean and the projection of those real reasons into the readiness
vocabulary are synthesized. The adapter genuinely is `failed` when the harness
reads not-ready, because arming drives the ownership premise through
`beginWrite` before the capture — and the target asserts that observation
actually reached the adapter rather than assuming it did.
`prunedRecordCount` is the only other synthesized value: V1 implements no
retention prune, so no durable prune record exists to count, which is the same
fact the report states as `retentionPruneExecution: "not-executed"`. Every
other snapshot field is a real query.

`ambiguous_commit` is only half expressible here, and the limit is recorded
rather than worked around. The armed point throws at `COMMIT` before delegating,
so the caller does not learn the outcome — that half holds. The other half, that
it may actually have committed, cannot be represented: measured, a fault thrown
after a successful COMMIT leaves the row durably present and the following
ROLLBACK raises `cannot rollback - no transaction is active`, which the adapter
swallows before returning `store_failure`. The harness pins `stateMutated:
false` and compares graph state against a baseline, so that shape fails as
`mutation_applied_while_unavailable`. Phase 2.4 used the opposite direction — a
real commit with only the response lost — because its section asserts a
different invariant, and it is not a precedent to copy here.

The section 2.9 boundary is held in code rather than by intention.
`readConformanceStaleProjection` computes a checkpoint, a high-water mark, and
the gap between them, and contains no judgment ladder: the Phase 2.5 stale-read
shape has no field to put a verdict in, and Phase 2.7 already proves the
`projection_incomplete`/`projection_unavailable`/`no_evidence_path`
distinction. The lag is a stored fact rather than a chosen constant — `open()`
seeds three graph sources and no projection batch, leaving a checkpoint of zero
against a high-water mark of three. Seeding inside `open()` is what keeps it
outside the harness's counters, which are exact equalities rather than upper
bounds — 18 commands, 10 lifecycle transitions, 14 snapshot controls, 14 fault
controls, two stale reads, two readiness captures, five targets — and which
count only what the harness issues, never what a target does to establish its
own starting state.

The adversarial matrix is five controls and each one reaches the check it
exists to fail. Against the recurring failure this section has now caught seven
times — a matrix that passes because nothing ran — the run additionally asserts
exact per-seam refusal counts: two real `SQLITE_BUSY` collisions, ten real
`ownership_lost` transitions, and one real throw at COMMIT, which together with
the five commands issued unarmed account for all 18 the harness pins. A seam
that silently stopped being installed moves one of those numbers.

Two predictions from the investigation held and one did not. The seeded fault
order was predicted and confirmed as `timeout`, `unavailable`, `delayed-read`,
`ambiguous-commit`, `lost-fence`, and the `SQLITE_BUSY` behaviour was predicted
and confirmed by direct measurement before any target code existed. The
prediction that the Phase 2.3 one-shot fault seam could be reused did not
survive contact with the harness, for the reason recorded above; a later target
should read a harness's arm-to-command ratio before copying any earlier switch.

The Phase 2.5 repeat item stays unchecked, and here the reason is narrower than
the earlier four. That item binds two things: repeating the fault matrix
through SQLite/shared adapters, which this slice does, and separately proving
real partition behaviour against a live authority, which it does not — a
single-process SQLite file has no authority to be partitioned from. Injected
unavailability is not a partition, and checking the item would claim it was.

### Slice I, first part — the Phase 2.1 lease target, and what "inline writer" means

Before the target itself, an ordering fact that was easy to get wrong. The two
unchecked writer items above are not independent, and the worker one is not
startable yet. `plan.md`'s Phase 2 says "Reuse the optional FIFO worker writer
only after direct-mode conformance; reads remain bounded and
consistency-declared", and its exit gate is "both inline and worker-writer
SQLite modes pass the same V1 suite." So `Prove inline writer conformance` is a
prerequisite for the worker item rather than a sibling of it, and what it
cashes out to is running every Phase 2 harness through the adapter — the work
slices F, G, and H have been doing one section at a time. Five of the seven
were done before this slice; `2.1 lease` and `2.6 expiry` were the remainder.

The worker item also has a second gate that is worth recording now rather than
rediscovering: the spec attaches the declare-consistency duty to reads that
decide authorization, claim, finalization, ACK, prune, or cutover (section 6.2)
and puts it on `query`, but the adapter exposes eight members and `query` is
not among them. There is no read surface on which to declare anything yet.

Slice I, first part, drives the Phase 2.1 harness through the adapter in
`packages/broker/src/shared-state-sqlite-lease-target-v1.test.ts`. Adapter
source is unchanged, as in the five earlier targets.

Two things here are new. It is the first target to open **two adapters on one
database file**: the harness asks for a second simultaneous owner and requires
it to fail closed, and the refusal is the adapter's own — `open()` meets a live
foreign `owner_token` and answers `ownership_conflict` without waiting and
without taking over, leaving the holder untouched at `ready`. A separate test
also shows the refusal is a conflict rather than corruption, by releasing the
holder and watching the contender then acquire the same file. The reference
model could only assert that behaviour; this runs it. It is also the first
contended barrier against real SQLite: thirty-two contenders claim one
resource, exactly one commits, and the other thirty-one are rejected
`claim_conflict` by the adapter's own ladder — which puts `claim_conflict`
ahead of `version_conflict`, so a contender that met a live holder is told what
actually stopped it rather than being told its version was stale.

One fault point collapses under decision 2. `after_resource_mutation` and
`after_audit_outbox_staging` are one instant, because V1 stages neither an
audit record nor an outbox event for a lease: `claimLease` writes exactly one
row, to `shared_state_lease`. "After the staging" and "after the resource
mutation" are therefore the same moment, and separating them would invent a
boundary. Four armed points, three distinct positions, and a test asserts the
collapsed pair really does fire twice at one position.

Reaching that position needed a seam none of the earlier targets had. The two
proxy hooks used so far — intercept `prepare`, intercept `exec` — can only fire
*before* a statement runs. An "after the resource mutation" fault has to land
with the row already written and the transaction still open, so the target
wraps the prepared statement and throws from `run` after delegating. That the
snapshot is then unchanged is real rollback evidence rather than evidence that
nothing was attempted.

Decision 3 is applied more widely here than in any earlier slice — three of the
nine snapshot counters — and the reason is worth stating plainly because it
changes what the checked item claims. `auditCount` and `outboxCount` are the
notable pair: the harness requires each to be **one** after a clean claim, not
zero. V1 has no audit table at all — the schema ships eleven `shared_state_*`
tables and none is an audit log — and a lease command appends no outbox event.
Both are therefore derived from the lease row the claim really wrote, so they
move with genuine adapter state rather than being constants, but neither is an
independent observation. `mutationCount` is a declared constant zero, the same
gap Phase 2.4 recorded as `leaseMutationCount`. The other six counters are real
queries, and a test asserts the derived, constant, and independent lists
partition the snapshot with no counter claimed in two of them.

The target deliberately does not make the pair real by appending an outbox row
of its own. Seeding starting state is legitimate — the Phase 2.5 target seeds
provenance the harness then reads as lag — but writing the very row a counter
is asserted against would manufacture the evidence instead of declaring its
absence, which is precisely what decision 3(iii) exists to prevent.

One envelope is constructed rather than returned. The harness wants the refused
second owner as a lifecycle envelope carrying `ownership_conflict`, and the
adapter reports that code through its result channel while rendering every
`failed` lifecycle as `adapter_unavailable`. The target pairs the adapter's
real error code with the adapter's real failed state; only the envelope shape
is the target's, and it is built through the contract parser rather than
assembled by hand, because the lifecycle kind is `V.kinds.lifecycle` and
getting it wrong fails parsing silently.

Five adversarial controls, each pinned to the exact error code it must produce:
a skipped injection, a second owner reported ready, a reopen that loses state,
a barrier that lets a second contender commit, and a zeroed audit counter. All
five reached their intended check on the first form, which is the first time in
this section that has happened.

The Phase 2.1 repeat item stays unchecked, for the reason the earlier ones do:
it also binds authorized query/reconciliation and retention behaviour that no
slice has performed.

The checked schema item above shipped eleven `shared_state_*` tables in
`packages/broker/src/shared-state-sqlite-schema-v1.ts`, derived from what
section 6.2 requires an adapter replacement to preserve — keys, fingerprints,
fences, sequence numbers, expiry instants, projection checkpoints, and stable
outcomes — plus the section 4.2 clock floor and the section 6.2
ownership/lifecycle epoch. Every table is `STRICT` and every statement is
`IF NOT EXISTS`, so applying the schema twice is a no-op and a wrong column
type fails closed at write time.

Slice B adds the lifecycle and ownership seam in
`packages/broker/src/shared-state-sqlite-adapter-v1.ts` and no primitive.
`open` validates the schema and contract version, then acquires exclusive
ownership and advances the lifecycle epoch inside one `BEGIN IMMEDIATE`
transaction, so two adapters racing the same file cannot both win. A second
adapter meeting a live owner token is refused with `ownership_conflict`
rather than waiting or taking over: the default `busy_timeout` is zero and V1
has no ownership lease, so waiting would convert a clear conflict into a lock
error and taking over would be the permissive answer. A refused open consumes
no epoch.

`beginWrite` is the guard every later command must pass. It rejects outside
`ready` and re-reads the ownership row, so a session whose token was taken
over — or whose epoch was superseded — stops being able to write instead of
continuing on a stale belief. `drain` stops writes before `close`, and `close`
releases ownership without lowering the epoch, so the next acquisition
resumes above it.

Slice C adds the first two primitives — `consumeReplayNonce` and
`reserveRateLimitCost` — behind that guard. Each runs inside one
`BEGIN IMMEDIATE` boundary that also contains the section 4.2 trusted-time
evaluation and the clock-floor advance, so a decision cannot commit against a
floor that did not durably move with it. The adapter still performs no clock
read: the observed instant is caller-supplied, exactly as the owner token is,
and the section 4.2 evaluator rather than the caller decides whether that
observation is safe. A backward observation beyond tolerance answers with the
existing `unsafe_clock` unavailable reason code and leaves the adapter
unwritable, which is the same fact Phase 2.4 proved at the lifecycle layer.
The clock-floor row is established by `open` rather than by the schema, because
it is bound to the adapter's clock profile and the schema slice implements no
adapter behavior; a row carrying a foreign profile is refused, not rewritten.

Records outside their logical boundary are deliberately left on disk. Removing
them during a decision would make physical cleanup timing observable in a
logical answer, which section 2.6 forbids — so the Phase 2.6 repeat item stays
unchecked on both halves: the boundary matrix is not yet driven through the
harness, and authorized retention execution at and after the boundary is a
separate exercise this slice does not perform.

Operations the adapter does not yet implement are refused with
`operation_not_implemented` rather than answered, because a placeholder answer
is indistinguishable from a real decision to a caller.

Slice D adds the four lease commands. Its semantics are not invented: Phase
2.1's conformance harness and its reference model already fix them, and two
orderings in the rejection ladder carry weight rather than being stylistic.

A contender that meets a live holder is answered `claim_conflict` before its
resource version is considered at all. Every loser of a claim race also holds a
stale version — the winner moved it — so checking the version first would
answer `version_conflict` to all of them and describe the wrong problem. A
caller presenting a superseded fence is answered `stale_fence` before owner,
expiry, or version, so a fenced-out writer learns nothing about the current
holder. The fence it is compared against is the stored high-water mark rather
than the active claim: neither release nor expiry lowers it, so an old fence
stays stale even when nothing holds the resource, and the next claim always
resumes above every fence ever issued.

`releaseLease` alone skips the expiry check. Releasing an expired lease is how
a holder cleans up after itself; refusing it would leave the row claimed until
something else took over. Releasing when no claim is held is
`invalid_state_transition`, not `lease_expired` — the release reason vocabulary
does not contain the latter. A `checkpoint` mutation keeps the claim; every
other mutation kind ends it, which makes the resource immediately claimable
without waiting for the lease to expire.

The table shape held again here. The reference model's attempt counter
and its fence both advance on claim and only on claim, so they are always
equal, and the attempt number is derived from the fence rather than needing a
column of its own. Resource state is derived from whether an attempt is
recorded. `attemptKeyDigest` is produced by `claimLease` and consumed by the
other three, so the adapter derives it, binding `resourceId` to the resource
key digest — the only resource-identifying material a caller gives it — and
`attemptNumber` to the fence the claim just took.

Two gaps are recorded rather than papered over. The Phase 2.1 repeat item
stays unchecked: the harness additionally requires audit and outbox rows staged
inside the same transaction as the resource mutation, and rejected commands
must stage neither. That crosses into the outbox slice and is not implemented
here. The harness also exercises a single resource; multi-resource behavior is
covered by tests added in this slice rather than by the harness.

Slice E adds `executeIdempotent`. Its semantics come from Phase 2.2 the same
way, and its shape is unusual in two respects worth stating.

It takes no observed instant. The registered namespaces are
`non-expiring-until-prune-proof` with a null logical expiry boundary, so an
idempotency record has no TTL for a clock to be compared against. Retention is
released by an authorized prune, which is neither this slice nor an adapter
decision, and inventing an expiry would be the permissive answer in reverse.

A replay returns the **stored** outcome rather than deriving it again. The
distinction only becomes visible when a retry repeats the key and payload but
declares a different effect: re-deriving would answer with the new effect's
outcome, which would let a later caller restate what already happened. The
first execution is what happened.

Idempotency namespaces are registered rather than free-form, and the contract
parser already refuses an unregistered namespace and a mismatched retention
policy before a command can reach the adapter. The adapter repeats the catalog
check as defence in depth. An unregistered namespace is answered as an adapter
failure rather than a rejection, because the rejection vocabulary
(`idempotency_conflict`, `unknown_idempotency_outcome`,
`retention_policy_mismatch`) contains no code for it, and answering one it does
not contain would be inventing it.

`outcomeDigest`, like `attemptKeyDigest`, is produced by the command and never
supplied to it, so the adapter derives it: `outcomeType` from the declared
effect kind, `outcomeBody` from the domain mutation digest. V1 executes no
effect of its own, so the mutation the caller declared is the only thing an
outcome can be bound to.

The Phase 2.2 repeat item stays unchecked for the same reason as Phase 2.1:
the harness requires an outbox append staged inside the same transaction, with
rejected commands staging nothing. Both sections now wait on the outbox slice,
which makes slice F the point at which three repeat items — 2.1, 2.2, and 2.3
— become checkable together.

Phase 2.2's outbox requirement is structurally stronger than Phase 2.1's: its
snapshot equivalence class counts an outbox append as one of five required
effects and its transaction fault points include one immediately after outbox
staging, so the harness cannot be satisfied without it. Three measured facts
say the gap is not simply "write the row anyway", and slice F should settle
them before assuming otherwise:

- `shared_state_outbox` has nine `NOT NULL` columns, while the
  `executeIdempotent` effect supplies four fields. `idempotency_key_digest`,
  `stream_sequence`, `receipt_state`, and `acknowledgment_state` have no
  source in the command.
- `idempotency_key_digest` cannot be filled from `keyDigest`: they are
  different digest domains (`broker.outbox.idempotency-key` versus
  `broker.idempotency.key`).
- The retention policy the Phase 2.2 harness attaches to that effect,
  `caller-owned-outbox.v1`, is not among the three registered outbox retention
  policy versions. It exists only in test and conformance sources.

Section 5.4.1 of `spec.md` already says outbox append, receipt, and
acknowledgment remain separate section 6.1 operations, are not aliases for
`executeIdempotent`, and use the separate closed registry in section 5.5.1.
That is consistent with the measurement: the effect's retention policy is
absent from the outbox registry because the effect is a caller-owned link, not
a registered outbox row. Whether that link is represented in
`shared_state_outbox` or elsewhere was a slice F decision, and it was the first
place in this section where the table shape genuinely had to move. It is now
settled: `shared_state_idempotency_outbox_link`, described earlier in this
section, which took the shape from eleven tables to twelve.

That separation is now confirmed from the other side. The outbox commands write
`shared_state_outbox` and supply all nine of its columns directly, exactly as
the measurement predicted; the link table is untouched by them. The two paths
never contend for the same row, so no reconciliation between them was needed —
and none was invented, since no V1 reader consumes either one.

Slice G adds the three claim-graph commands. Phase 2.7 has no policy module to
reuse — unlike section 2.6's time module or section 2.2's catalog evaluator,
its only normative source is the conformance harness and its reference model —
and the contract parser enforces digest domain and namespace bindings but no
catalog, so graph namespaces stay free-form.

Idempotent replay comes before every precondition, for the same reason the
lease ladder puts `claim_conflict` first: a retrying producer necessarily holds
a stale expected sequence, because its own first attempt advanced it, so
checking the sequence first would answer `source_sequence_conflict` about a
fact that is already durable.

Source sequences are one space per namespace rather than one per stream. That
is forced rather than chosen: a projection batch names a `[from, through]`
range with no stream qualifier, so the range is only meaningful if sequences
are unique across the namespace. The stream key is recorded as provenance.

A rollback restores the checkpoint the batch was applied over rather than
decrementing, so the projection checkpoint is not monotonic; only the source
high-water mark is. A batch that has been rolled back stays recorded and
replays if reapplied, so its inverse-removed effects are never resurrected.

Nodes and edges are not stored. They are exactly derivable from the
`[from, through]` range of every batch that has not been rolled back — one node
per sequence in the range, one edge from the first sequence to each later one —
so materializing them would duplicate the batch rows. Rollback removes a
batch's effects rather than tombstoning them, so there is no tombstone state to
keep either. This is why the absence of node and edge tables is not a gap.

Two findings are recorded rather than worked around.

The first is a contract asymmetry. `applyGraphProjectionBatch` requires a
**positive** checkpoint sequence in both of its decisions, while
`rollbackGraphProjectionBatch` allows zero. Rolling back the first and only
batch therefore legally returns checkpoint zero, and the `replayed` answer for
reapplying that batch cannot be expressed at all. The adapter refuses rather
than inventing a checkpoint, because it never emits an envelope it could not
itself parse, and a test pins that behavior.

The second is a shape gap. The reference model keeps a set of rollback batch
keys so it can tell a repeat of the same rollback from a different one;
`shared_state_graph_batch` records only that a batch was rolled back. The
adapter therefore replays any rollback of an already-rolled-back batch,
regardless of key. Replaying is the narrower of the two answers — it never
re-runs an inverse — and the Phase 2.7 harness only ever issues one rollback
key per batch, so it does not separate them. Recording rollback keys would need
a column this shape does not have, and adding one is more expensive than it
looks: every statement is `CREATE TABLE IF NOT EXISTS`, so a new column would
not reach an existing database, and raising the schema version would reject one
outright. Nothing operational has been written yet, which is the cheapest
moment to revisit it if a reviewer prefers fidelity over narrowness.

Three rejection reason codes in the closed vocabulary — `source_fact_conflict`,
`projection_batch_conflict`, and `unknown_idempotency_outcome` — have no
trigger in any harness, reference model, or spec text. None was invented for
them.

`Implement all primitives` is now checked. Slice F's second part adds the three
outbox commands, which were the last operations the adapter refused, so all
thirteen storage V1 operations are implemented inside the one `BEGIN IMMEDIATE`
boundary. The writer and read-consistency items are untouched.

The outbox slice reuses the section 2.3 evaluator rather than restating it. One
entry point, `evaluateSharedStateOutboxPolicyV1`, already answers the closed
purpose registry, the three policy version bindings, the ordering scope, the
recomputed stream key digest, the receipt transition table, and the
acknowledgment evidence gate. What was left for the adapter is what the
evaluator cannot know: whether a row exists, and what sequence comes next. Its
field list is a strict subset of the command input, so the command is projected
onto it — passing the three digests the evaluator does not take would be
answered with `unknown_field` rather than a policy decision.

Sequence allocation is the adapter's job by registration, not by choice:
`adapter-allocated-per-exact-stream-key` with `callerSequencePolicy:
"forbidden"`, which the evaluator enforces by scanning the whole input tree for
a caller-supplied sequence field before it looks at anything else. Two measured
details shaped the implementation. `stream_sequence` is TEXT, so SQL `MAX()`
compares it lexically and answers `"9"` for a stream that already reached
`"10"`; the maximum is taken as `BigInt`, and a test appends eleven events
because that is the shortest run which reaches the collision. And the
idempotency binding is keyed by `idempotencyKeyDigest` rather than by the event
id, because the registered answer is that the same key and payload return the
ORIGINAL event id and sequence — so the original has to be found by the key the
producer retried with.

Receipt and acknowledgment evidence digests are validated by the contract and
then not stored. Nothing in V1 reads them back: they appear in no conformance
snapshot counter and in no reconcile response. Adding columns for values no
reader consumes would be inventing durable state, so the twelve-table shape did
not move for this slice.

Two rejection codes in the outbox vocabulary have no trigger and none was
invented for them. `ordering_conflict` has no defining condition in any harness,
reference model, or spec text, and mapping the evaluator's
`ordering_scope_mismatch` onto it would misdescribe a refused policy binding as
a sequence conflict. `ack_state_conflict` is unreachable for a different
reason: the policy forces `expectedAcknowledgmentState` to `unacknowledged`, and
a row that is already acknowledged is answered `already_acknowledged` before the
expected state is compared — calling that a conflict would refuse the retry the
idempotent decision exists for.

`acknowledgeOutbox` is the one operation where no policy failure maps to a
rejection at all. Its three codes — `event_not_found`, `receipt_not_confirmed`,
`ack_state_conflict` — all describe stored row state, while a forbidden purpose
or non-acknowledging evidence describes the command. Those are reported as
adapter failures under `unregistered_outbox_registration` rather than dressed as
one of the three, on the same principle slice E applied to an unregistered
idempotency namespace.

Seven adversarial controls were run against these assertions and all seven went
red: a lexical sequence maximum, a removed `already_acknowledged` short circuit,
a disabled event-id takeover check, a removed receipt compare-and-set, a global
instead of per-stream sequence space, an idempotency lookup keyed by event id,
and an acknowledgment that does not require confirmation. This is the first
section 3 slice where no control passed, so no coverage gap had to be closed
after the fact.

A conformance target now exists for Phase 2.3 as well, in
`packages/broker/src/shared-state-sqlite-outbox-target-v1.test.ts`. It drives
the real Phase 2.3 harness against the V1 SQLite adapter: seven isolated
database files, thirty target commands, eight producers released from one
barrier across two streams, a close and reopen of the same adapter instance,
three reconciliation controls, and all three armed fault points. The adapter
gained nothing — a test asserts that none of `snapshot`, `armFault`,
`reconcileConformanceControl`, or the three outbox commands appears on its
prototype.

This is the first target that needs NO fault-point collapse. All three armed
points land on distinct real instants: `domain-before-append` on the outbox
INSERT as it is prepared, which is before any durable write, and the two commit
points on the commits of the append and the acknowledgment. The last two match
the same SQL text because both are commits, but they are positions in different
commands, and a fault is consumed by the single command that follows it. The
declared count of real positions therefore equals the count of armed points,
and the descriptor records an empty collapse list rather than omitting the
field.

One counter is collapsed and says so. V1 keeps no durable record of a domain
effect apart from the event it appended, so `domainEffectCount` is derived from
the outbox row count; the harness holds `domainEffectCount === outboxEventCount`
at every point it checks. Every other counter is a real query over stored
state, `receiptFailedCount` included — it reads zero because no scenario fails
a receipt, not because it is hard-coded, which is a stronger position than the
Phase 2.2 target could take.

Two of the five adversarial controls passed on their first form, and both were
the same mistake: the control never reached the check it was written for.
Replaying acknowledged events changed nothing, because the one acknowledged
event sits below the cursor floor that already excluded it — the control had to
bypass the floor for acknowledged rows to reach the harness invariant. A reopen
onto a fresh database also changed nothing, because the target's observation
handle still pointed at the original file, so the loss was invisible to the
snapshot; the read handle had to move with the adapter. Both now fail with
`reconcile_invariant_mismatch` and `reopen_snapshot_mismatch`. This is the
sixth occurrence of a control passing for lack of reachability rather than for
correctness, and it stays worth writing down: a green control is evidence about
the test, not about the code.

A conformance target now exists for Phase 2.7. It lives in
`packages/broker/src/shared-state-sqlite-claim-graph-target-v1.test.ts` and
drives the real Phase 2.7 harness against the V1 SQLite adapter — three
isolated database files, 31 storage V1 commands, six lifecycle transitions,
one injected projection fault. `SharedStateSqliteAdapterV1` gained nothing: a
test asserts its prototype still carries exactly `lifecycle`, `open`,
`beginWrite`, `transact`, `drain`, `close`, and the two accessors, and that no
seam name appears on it.

The fault seam is the part that needed a decision. The adapter cannot be asked
to fail, and giving it a way to be asked would be adding a storage API the
contract does not register. So the target proxies the `DatabaseSync` handle the
adapter was constructed with and throws when the adapter prepares the
checkpoint write. The adapter's own `BEGIN IMMEDIATE` boundary then performs a
real `ROLLBACK`. All-or-none is observed rather than simulated, and a separate
test asserts the batch insert was prepared **before** the trigger fired — a
fault landing before any write would leave identical observable state and prove
nothing, and the harness cannot tell those apart.

Nodes and edges are derived rather than stored, which is the shape slice G
committed to and it is exact for this harness: one node per source sequence in
a live batch's `[from, through]` range, one edge from the first sequence to
each later one, and no tombstone state because rollback removes a batch's
effects rather than tombstoning them. One assumption rides along and the
harness does not exercise it — batches must not overlap, or a sequence covered
by two live batches would count as two nodes. It is recorded here rather than
left to look proved.

Three adversarial controls were required to make the assertions credible, and
all three fail the harness as intended: counting rolled-back batches as live
fails `rollback_restoration_mismatch`, accepting the arm request without
injecting fails `checkpoint_advanced_on_fault`, and leaving the authority
reported available after a real fault fails `evidence_path_mismatch`.

The Phase 2.7 repeat item still stays unchecked, now for one reason instead of
two: the item also requires a real graph query surface, and
`evaluateConformanceEvidencePath` is explicitly not one, because V1 registers
no query operation. The seam gap that blocked it is closed; the query surface
is a separate piece of work.

A second target follows in
`packages/broker/src/shared-state-sqlite-idempotency-target-v1.test.ts`, which
drives the Phase 2.2 harness through the adapter: eight isolated database
files, 78 operations, 64 same-key commands released at one barrier, a real
close and reopen of the same database, and all five fault points.

It extends the fault seam rather than reusing it unchanged. The Phase 2.7 seam
intercepts `prepare` only, which was enough for a fault point sitting between
two prepared statements. `BEGIN IMMEDIATE`, `COMMIT`, and `ROLLBACK` are issued
through `exec`, so a commit-boundary fault point needs `exec` intercepted too,
and `after_outcome_staging` is exactly that point.

This is also the first place the collapse decision is used. Its terms are met
literally: the four transaction fault points map onto three real positions, the
collapse and its reason are stated in a frozen descriptor the tests assert
against, no boundary is fabricated, and the adapter grew no durable write to
manufacture one. The descriptor also names which snapshot counters share a row,
which extends the decision from fault points to counts and is recorded as an
extension rather than folded in silently.

Four adversarial controls were confirmed RED. Two are worth naming: a blanket
skip of fault injection fails at `ambiguous_commit_mismatch`, which means it
never reaches the transaction fault matrix at all — so a second control that
skips only the statement triggers was added, and it fails at
`transaction_not_atomic`. Without it the statement mapping would have had no
control over it. The other two are double-counting the outbox append and
letting an ambiguous commit roll back instead of committing.

A separate test asserts all three statement positions are actually reached in
the adapter's order, because a collapse onto boundaries that are never reached
would pass the matrix for the wrong reason.

The first schema slice implements **no adapter behavior**: no transaction
boundary, no
primitive, no clock read, no ownership acquisition, and no runtime wiring. It
creates the ownership and clock-floor row shapes without claiming ownership or
reading a clock. A foreign schema or contract version is rejected rather than
migrated, because V1 defines no upgrade path and adapting silently would be
the permissive answer. Tests inject temporary database paths; the operational
path decision belongs to section 4 and is deliberately not made here.

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

Section 3 slice B (lifecycle and ownership):

```bash
npm run build --workspace=a2a-broker
node --test packages/broker/dist/shared-state-sqlite-adapter-v1.test.js
npm test --workspace=a2a-broker
npm run check
git diff --check
```

The focused slice B command proves only lifecycle transitions, exclusive
ownership refusal, epoch monotonicity across close and reopen, and the write
guard. It proves no primitive, because that slice implements none.

Section 3 slice A (V1 schema):

```bash
npm run build --workspace=a2a-broker
node --test packages/broker/dist/shared-state-sqlite-schema-v1.test.js
npm test --workspace=a2a-broker
npm run check
npm run scan:public-readiness
npm run scan:external-secrets
npm run check:markdown-links
git diff --check
```

The focused slice A command proves only that the V1 tables are created,
reapplied idempotently, read back, isolated from a legacy database, and
rejected on a foreign version. It proves no adapter behavior, because that
slice implements none.

The focused Phase 2.5 command proves only the backend-neutral partition and
unavailable-injection harness against the detached test-only reference model.
Its readiness control reports the adapter-lifecycle view and is not `/readyz`,
middleware, or a route contract; its stale-read control is not a V1 storage
query. SQLite/shared adapter conformance, real partition behavior against a
live authority, runtime integration, retention/prune execution, readiness
route behavior, migration, deployment, live rollout, and overall issue
completion remain out of scope.

### Slice I, second part — the Phase 2.6 expiry target

Slice I, second part, drives the Phase 2.6 harness through the adapter in
`packages/broker/src/shared-state-sqlite-expiry-target-v1.test.ts`. Adapter
source is unchanged, as in the six earlier targets. This is the last of the
seven Phase 2 harnesses; `Prove inline writer conformance` is now the suite
itself rather than a remaining section.

Two things here are new, and both come from what V1 does not do. The adapter
has no `DELETE FROM shared_state_*` path: a logically expired replay, rate, or
lease row stays on disk, and the exclusive boundary — `observed == expires` is
already expired — is the adapter's own evaluator. Section 2.6 requires
`attempt-early-eviction` to be refused so that physical cleanup timing cannot
become an input to a logical answer; V1 refuses it structurally, which is why
the retain is evidence rather than a declared synthesis. A dedicated test
consumes the same nonce at `expiry-1` / `expiry` / `expiry+1` and counts one
row across the overwrite, so the exclusive instant and the missing delete path
are both observed rather than inferred.

There is no fault-injection surface. The six earlier targets all wrap the
database handle; this one does not, because the Phase 2.6 harness has no
`armFault` and its two controls — cleanup and capacity — are both synchronous
and test-only. Two handles are enough: one for the adapter, one raw for
observation. Copying a proxy seam here would have been invention.

The clock shape is the Phase 2.1 / 2.4 one, with two traps that are easy to
copy wrong. `create({clock})` is required, and the method is
`readObservedUnixMilliseconds`, not the Phase 2.1 `readLogicalMilliseconds`.
The seven targets share one clock; constructing a fresh one per target would
desynchronize the probe points. And `backwardSkewToleranceMs` is `"10"`, the
harness's own `TIME_POLICIES` value: five of the six earlier targets pass
`"0"`, and Phase 2.4 already recorded that copying them fails the
policy-agreement check even when the clock only advances. The observation is
passed through verbatim. A target-owned counter would break every boundary
probe.

Decision 2 has nothing to collapse. No fault points are armed, so the
collapsed list is empty, and a test asserts it does not overlap the synthesis
list. An empty collapse is still a declaration: a later reader should not have
to infer that the absence was considered.

Decision 3 is one field, cut as narrowly as (iii) requires.
`ownershipEpoch` is the harness's lease-claim generation — `"1"` after the
first claim, `"2"` after an atomic reap/new-claim. V1 has no
lease-ownership-epoch column. The nearest real durable value is
`shared_state_lease.fencing_token`, which rises on claim and only on claim.
The investigation note that named `shared_state_ownership.lifecycle_epoch` is
wrong on the meaning, and a dedicated test pins why: `open` establishes the
session epoch at `"1"`, a reclaim leaves it there, and the fence is what
moves to `"2"`. Mapping the snapshot field onto the ownership row would fail
scenario D. The target does not invent a column or write a generation counter
of its own; it reports the fence the claim really wrote, and the descriptor
says so.

`physicalCleanupState` and `capacityPressureBand` are not syntheses. The
harness header already calls them test-only controls; the target reports the
control it was last asked to apply. They sit in a third list so a later reader
cannot mistake a control report for a missing durable column. The other
fourteen snapshot fields are real queries over stored state, with TEXT
sequences compared as BigInt because SQL `MAX()` ranks `"9"` above `"10"`.

Capacity shedding is a target-level control, not an adapter API. Critical
pressure refuses new work with `unavailable` / `authority_unavailable` and
still forwards an unexpired replay of an existing nonce, or a replay of an
existing idempotency key, so the adapter's own accept/replay decision is what
the harness sees for the retained records. The target looks those rows up on
the raw handle before calling the adapter; it does not write a row and then
undo it.

Five adversarial controls, each pinned to the exact error code it must
produce: an early eviction that deletes the active replay, a pressure band
that drops unexpired safety records, a clock that treats the exclusive instant
as still active, a snapshot that silently retires an unacknowledged outbox
row, and a critical band that still accepts new work. `reopenLosesState` was
considered and dropped: the Phase 2.6 harness never reopens a target, so that
control would be consumed by `close` and then sit unused — the pattern this
section has now caught eight times, a matrix that passes because the check was
never reached.

The Phase 2.6 repeat item stays unchecked, for the reason the earlier ones do
and for one more that is this slice's own. That item binds two things:
repeating the boundary matrix through SQLite/shared adapters, which this slice
does, and separately proving authorized retention/prune execution at and after
the logical boundary, which it does not. V1 has no delete path to run such a
prune through, and checking the item would claim the second half was done.

### Slice I, closeout — what the 487 check means, and why 488/489 stay closed

The inline-writer box above is now checked. The meaning is the one Slice I,
first part already fixed: every Phase 2 harness runs through the adapter's
inline `transact` path. That is seven targets and seven passing reports, and
it is not the section 6.1 surface. The adapter still exposes eight members
(`ownerToken`, `lifecycleEpoch`, `lifecycle`, `open`, `beginWrite`,
`transact`, `drain`, `close`) and not `metadata`, `withTransaction`, `query`,
or `health`. Checking 487 does not claim those members exist, does not claim
a worker-writer mode, and does not check any of the Phase 2.x repeat items.

488 and 489 stay unchecked by owner decision C (2026-08-23 KST,
`#1504` issuecomment-5381339233). They are the write face and the read face
of one observation problem: a FIFO worker makes writes durable only after
ACK, and section 6.2 requires the reads that decide authorization, claim,
finalization, ACK, prune, or cutover to declare consistency. The spec puts
that declaration on `query`. The adapter has no `query`, so there is no
surface on which to declare anything and no surface on which to prove that
an unacknowledged write is not observed as committed. Implementing 488
without that surface would let the item close on write evidence alone.

The existing optional FIFO worker (`sqlite-worker-thread-persistence.ts`) is
the legacy `SqliteBrokerStateStore` path. It is a different file, a different
schema, and a different connection. Reusing it here would be a nested or
cross-adapter transaction, which section 6.2 forbids. Decision C therefore
leaves 488/489 untouched until Phase 3, when `/readyz` and non-serving
middleware make a read surface necessary. The alternatives recorded and not
chosen were A (add a minimal `query` now) and B (split 488 so today's empty
in-flight `drain` counts as a half). `plan.md`'s Phase 2 exit gate still
names both writer modes; that gate stays open on the worker half.
