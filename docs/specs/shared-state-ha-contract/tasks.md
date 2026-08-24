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

- [x] Add exact grade and expected-process configuration.
- [ ] Add startup version/capability/clock/schema/migration checks.
- [x] Add fenced singleton ownership and loss monitoring.
- [x] Add `/readyz` and state-authority non-serving middleware.
- [x] Assert `/readyz` becomes false and non-liveness routes stop serving
  while `/livez` remains liveness-only. Moved here from section 2.5: the
  assertion needs the middleware above, so it cannot be proved by a
  backend-neutral Phase 2 harness.
- [ ] Add secret-safe `stateContract` health without identity-bearing top-key
  data.
- [x] Add volatile replay/rate reset-risk epoch/reason signals.
- [x] Make `shared-state-ha` fail until an approved conforming backend exists.
- [ ] Integrate primitives one at a time behind default-off flags.
- [ ] Run compatibility/regression/performance tests.

### Slice J, first part — grade and expected-process configuration

Slice J, first part, adds the closed configuration parser in
`packages/broker/src/shared-state-deployment-grade-v1.ts`. It does not bind a
socket, open the V1 adapter, install `/readyz`, or change broker defaults.
The broker still does not read these variables.

The two keys are `BROKER_DEPLOYMENT_GRADE` and
`BROKER_EXPECTED_PROCESS_COUNT`. An omitted grade defaults to
`single-process` with `gradeDefaulted=true`, which is the section 3.1
backward-compatible default. An omitted count defaults to `1`. A present
empty string is a misconfiguration, not an omitted default.

`multi-process-unsupported` is refused as a configured value. It remains an
effective grade for a later live ownership conflict, which this slice does
not detect. `shared-state-ha` fails closed with `shared_backend_unavailable`
because no approved conforming shared adapter exists; the parser records
`approvedSharedBackend: false` rather than inventing a backend name. An
expected process count other than `1` fails closed under both servable
single-writer grades, which is the section 3.1 rule that those grades MUST
NOT start with a replica count greater than one.

The later items in this section — startup checks, ownership-loss monitoring,
`/readyz`, non-serving middleware, and `stateContract` health — stay
unchecked. They are the consumers of this decision, not part of it. Item
`Make shared-state-ha fail until an approved conforming backend exists` also
stayed unchecked after this part: the parser already refused that grade, but
startup did not yet call the parser, so a process could still boot without
seeing the refusal.

### Slice J, second part — startup calls the parser

Slice J, second part, makes `createBrokerServer` call
`resolveSharedStateDeploymentGradeFromEnvV1` next to the existing startup
security check. A rejected grade throws before the HTTP server listens, so
`startBrokerServer` and `startTestServer` both see the refusal. The throw
carries only the closed parser error code.

An omitted grade still defaults to `single-process` and still constructs.
`BROKER_DEPLOYMENT_GRADE=shared-state-ha`, a present empty string, and an
expected process count other than `1` now fail closed at construction.
That is what checks `Make shared-state-ha fail until an approved conforming
backend exists`: the process can no longer boot past the parser refusal.

This part does not stash the decision on the runtime, add a
`BrokerServerOptions` grade field, open the V1 adapter, acquire ownership,
install `/readyz`, change `/health`, or publish `gradeDefaulted`. Those stay
with the later items. 488/489 stay decision C.

### Slice K, first part — acquire the serving fence at construction

Owner decision A+A1 (2026-08-23 KST, `#1504` issuecomment-5383391750):
the singleton serving fence is the V1 `shared_state_ownership` CAS, used
for both JSON-file and SQLite persistence. A new lock is not invented.
`BROKER_SHARED_STATE_FILE` overrides; otherwise the path is
`${stateFile}.shared-state-v1.sqlite`. The legacy `SQLITE_STATE_FILE` /
`BROKER_SQLITE_FILE` is never that file. An injected test `stateStore` is
not the `STATE_FILE` identity, so it gets an isolated temp fence unless the
path was set explicitly. If the derived directory does not exist and the
state file is still the hardcoded `/var/lib/a2a-broker/state.json` default,
the fence is isolated rather than creating that system path from tests.

Slice K, first part, makes `createBrokerServer` apply the V1 schema if
needed and `open()` that file before the HTTP server is created. A live
foreign token fails closed with `ownership_conflict` and listen never
happens. The owner token is a per-process random UUID, never `BROKER_ID`.
Graceful `closeWorkerPersistence` / `server.close` drains and releases the
token so a later process can acquire. Crash without release leaves the
token set. That is A1, not a lease.

A child-process test proves two broker processes cannot both acquire the
same file, and that a successor can acquire after the holder releases.

This part does not check `Add fenced singleton ownership and loss
monitoring` or `Add startup version/capability/clock/schema/migration
checks`. `open()` validates schema/version/clock on the fence file, but
there is no loss monitoring, no `/readyz`, no non-serving middleware, no
`stateContract`, no primitive integration, and no ownership lease. 488/489
stay decision C.

### Slice L, first part — `/readyz` re-reads the fence

Slice L, first part, adds `GET /readyz`. On each request it calls
`probe()` on the serving fence: the ownership row is read again, and the
process is ready only while the token is still this process's. The route
is public, like `/livez`. The body is `ready`, `effectiveGrade`, and at
most one closed readiness reason (`lost_fence` or `adapter_unavailable`).
No token, path, or filename is emitted.

A stolen ownership row makes `/readyz` 503. `/livez` stays 200. Other
routes still serve — non-serving middleware is the next part, not this
one. `/health` still has no `stateContract` or `gradeDefaulted`.

This part does not check `Add /readyz and state-authority non-serving
middleware` or the moved 2.5 assertion. Those need the middleware. It
does not start a background monitor, a lease, or 488/489. Decision C
stays: the route existing does not authorize implementing those items.

### Slice L, second part — non-serving middleware

Slice L, second part, refuses every route after `/readyz` and `/livez`
when `probe()` is not ready. The 503 uses the probe's closed readiness
code (`lost_fence` or `adapter_unavailable`) and the message
`state authority unavailable`. It does not call `beginDrain` and does
not emit `broker_draining`.

Auth stays first: a request without the edge secret is still 401. A
secret-bearing `/workers` after a stolen token is 503. `/livez` stays
200. `/readyz` stays the public probe.

That checks the middleware item and the moved 2.5 assertion. Loss
monitoring (background timer), `stateContract`, lease/A2, and 488/489
stay unchecked. Decision C is reopened as a question only — this slice
does not implement those items.

### Slice M, first part — `/health` `stateContract` without primitive bands

Slice M, first part, adds `stateContract` to authenticated `/health`.
It reports configured/effective grade, `gradeDefaulted`, `serving`,
`reasonCodes`, `topology.expectedProcessCount`, and `ownership`. The
adapter block is `legacy-process` with `contractVersion: null` because
V1 is the serving fence, not the serving store. Primitive reset-risk
bands are omitted.

The module does not import `shared-state-observability-v1`. The full
`stateContract` item and the reset-risk item stay unchecked. 488/489
stay decision C.

### Slice M, second part — process-local reset-risk bands

Slice M, second part, adds `primitives.replay` and `primitives.rateLimit`
to the same `/health` `stateContract`. Both bands are the closed process
fact: `source=process`, `durability=volatile`, `continuity=reset`,
`resetRisk=true`, `lastResetReason=process_start`. Age and pressure are
`unknown` because this slice does not collect live limiter or cache
stats and must not invent `low`. The module still does not import
`shared-state-observability-v1` or the storage-contract projector.

That checks `Add volatile replay/rate reset-risk epoch/reason signals`.
The full `stateContract` item stays unchecked: there is still no clock,
consistency, completeness, or graph projection block. 488/489 stay
decision C. Loss monitoring and primitive runtime integration stay off.

### Slice N, first part — P1 `lost_fence` latch without drain

Owner decision P1+S1 (2026-08-23 KST, `#1504` issuecomment-5385421354):
the first loss-monitor slice latches `lost_fence` for the process
lifetime. It does not call `beginDrain`, exit, release the token, or add
a lease. `adapter_unavailable` is not latched. Clock, consistency, and
completeness stay off the `/health` envelope (S1).

Slice N, first part, adds `packages/broker/src/shared-state-loss-monitor-v1.ts`.
`/readyz`, non-serving middleware, and `/health` inspect through the
monitor. A background interval also inspects so a stolen row is seen
without inbound traffic. The first `lost_fence` logs one closed line and
closes idle connections. Restoring the original token does not make this
process ready again.

This part does not check `Add fenced singleton ownership and loss
monitoring`. Drain/shutdown is the next sentence of section 7.1, not this
latch. 488/489 stay decision C.

### Slice N, second part — D1 close every connection, still no drain

Owner decision D1 (2026-08-23 KST, `#1504`): the latch callback closes
every HTTP connection (`closeAllConnections`), not only idle ones. The
close is deferred with `setImmediate` so the request that first observed
`lost_fence` can still write its 503. It still does not set `draining`,
emit `broker_draining`, exit, release the token, or add a lease.
`/readyz` and non-liveness routes keep the `lost_fence` reason.

This part still does not check `Add fenced singleton ownership and loss
monitoring`. Drain/shutdown remains a later sentence. The startup
version/capability/clock/schema/migration item also stays unchecked:
fence `open()` already validates the fence file, not the serving store,
and V1 defines no migration. 488/489 stay decision C.

### Slice N, third part — D3a exit after the lost_fence 503

Owner decision D3a (2026-08-23 KST, `#1504`): after the deferred
`closeAllConnections`, the process exits 1. It does not call
`beginDrain`, reuse the SIGTERM drain path, or emit `broker_draining`.
`/livez` dies with the process. A restart that still sees a foreign
token fails closed with `ownership_conflict` (A1). Tests inject
`lostFenceExit` so the runner does not die.

This part still does not check `Add fenced singleton ownership and loss
monitoring`. Drain is still absent. 488/489 stay decision C.

### Slice N, closeout — what the monitoring check means

Owner decision M1 (2026-08-23 KST, `#1504`): the item is checked with
the meaning its name already had. Slice K acquired the fence. P1 latches
`lost_fence`. D1 closes every connection. D3a exits 1. That is fenced
singleton ownership and loss monitoring.

`beginDrain` is **outside this item**. Calling it would hide `lost_fence`
behind `broker_draining`. A later drain slice, if any, is a new decision.
Checking this box does not authorize that work, does not add a lease,
and does not start 488/489. Decision C stays.

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

### Decision Q0 — open the query face before worker-writer or serving-store work

Owner decision Q0 (2026-08-23 KST, `#1504`): the next face is the closed V1
`query` contract. This reopens only alternative A from decision C now that the
Phase 3 HTTP/fence face has reached its recorded stop at `81e9ced0`. It does
not split 488, check 488/489, or authorize a FIFO worker, serving-store
promotion, primitive runtime integration, or an HTTP query route.

The first query contract has exactly two read families, because they are the
two gaps already named by the checked contract and harnesses:

1. **Outbox reconciliation** reads retained events and receipt/ACK state from
   an exact registered stream and cursor under the existing
   `serializable-per-stream` guarantee. It does not ACK, prune, send, infer
   provider acceptance as ACK, or create a global cross-stream order.
2. **Graph evidence path** answers with the existing four results
   `path_found`, `no_evidence_path`, `projection_incomplete`, and
   `projection_unavailable`, plus the declared source high-water, checkpoint,
   lag, projection version, and completeness. `no_evidence_path` remains valid
   only at a complete checkpoint.

Replay, rate, lease/claim, and idempotency do not gain standalone reads in this
decision. Their protected decisions stay inside the existing atomic
transaction commands; adding a preflight read would create a time-of-check /
time-of-use seam rather than a useful query contract. Metadata and secret-safe
health remain the separate section 6.1 surfaces already specified.

Every query request must name its required consistency and every result must
carry the achieved consistency and, where applicable, completeness. An
adapter that cannot meet the request returns the existing bounded unavailable
reason vocabulary in a closed unavailable result rather than a weaker
successful result. For a future FIFO worker, a query must not report a queued
write as committed before the writer's durable commit ACK: it must order behind
that ACK or return unavailable. The writer ACK is not an outbox receipt/ACK.
That rule is the later joint proof point for 488 and 489; this record alone
proves neither.

The next source slice after this decision is closed query values, request and
result schemas/parsers, synthetic fixtures, and fail-closed tests only. It
does not add `query()` to the SQLite adapter, reuse test-only reconciliation or
evidence-path controls as runtime APIs, touch broker runtime/HTTP, import the
observability catalog into `/health`, change `stateContract`, or alter any
default. Outbox and graph SQLite implementations follow as separate reviewed
slices. Serving-store authority remains legacy until a later explicit owner
decision names one primitive, one source of truth, and the retirement rule for
its legacy authority.

### Slice Q1 — closed query envelopes and parsers only

Q1 adds the source-only request/result contract that decision Q0 authorized.
`queryVersion=1` is separate from the transaction operation version, and the
two closed operations are exactly `reconcileOutbox` and
`queryGraphEvidencePath`. The slice adds no `query()` member to
`SharedStateStorageAdapterV1` or `SharedStateSqliteAdapterV1`; the envelopes are
validated data only, not an adapter, test-control alias, or runtime surface.

`reconcileOutbox` is bound to the one registered
`broker.terminal-outbox` namespace and one purpose-bound stream-key digest. It
accepts an adapter-opaque cursor and a page limit from 1 through 100. A
successful page reports the exact stream binding and only fields the planned
V1 row can preserve: event/payload digests, strictly increasing stream
sequence, receipt state, and acknowledgment state. Duplicate event keys,
non-increasing sequence, an ACK without a confirmed receipt, or a cursor whose
presence disagrees with `hasMore` fails closed. The query does not carry a
payload, send, ACK, prune, infer provider acceptance, or claim cross-stream
order.

`queryGraphEvidencePath` is bound to a namespace, projection version, and
claim/evidence source-fact digest pair. The caller bounds the path at no more
than 32 edges. A successful result uses exactly Q0's four evidence states and
reports achieved monotonic-eventual consistency, completeness,
`asOfSourceSequence`, projection checkpoint, source high-water, and exact lag.
A found path is an acyclic list of source-fact references whose first and last
members are the requested anchors. Negative evidence requires a complete
checkpoint; incomplete and unavailable are distinct non-judgment results.
The parser additionally requires `asOf == checkpoint <= high-water` and
`lag == high-water - checkpoint`.

Every request names the exact required consistency. A successful result names
the exact achieved consistency; an unavailable result carries `null` instead
of pretending a weaker guarantee and uses the query-safe subset of the
existing bounded unavailable reasons. Query parsers reject unknown versions,
operations and fields, consistency/completeness mismatches, digest
domain/namespace mismatches, caller clocks, backend commands, sensitive paths,
cross-operation result shapes, and the semantic page/path violations above.

The public synthetic fixture is
`packages/broker/fixtures/shared-state-storage/query-v1-golden.json`; it covers
both requests, an outbox page, all four graph states, and an unavailable
result. Focused tests parse every fixture and drive the negative matrix. No
section 2 repeat item, 488/489, full `stateContract`, primitive integration,
retention/prune, migration, performance, or operational item is checked by
this slice.

### Slice Q2 — SQLite outbox reconciliation only

Q2 implements only `reconcileOutbox` on `SharedStateSqliteAdapterV1`. The
method accepts the already parsed Q1 outbox request shape; it does not add
`query()` to the broad `SharedStateStorageAdapterV1` interface because the
graph evidence-path family remains a separate reviewed slice. Passing another
query operation at an untyped runtime boundary fails as not implemented rather
than pretending the SQLite adapter satisfies the full query union.

Each page checks the local ready lifecycle and then opens `BEGIN IMMEDIATE`.
This places the read behind every durable write made by the current inline
SQLite path and provides Q1's serializable-per-exact-stream observation.
Ownership is verified inside that same boundary so no token change can land
between authorization and the page read. A busy writer returns closed
`lock_timeout`; lost ownership returns closed `lost_ownership`; malformed
stored state or an invalid cursor returns
closed `authority_unavailable`. No weaker successful consistency is emitted.

The adapter-opaque cursor is versioned and bound to the query operation,
namespace, stream-key digest, and last returned sequence. Pages compare the
decimal sequence by length and then lexical value, rather than SQLite's plain
TEXT ordering, so `10` follows `9`. A malformed, tampered, or cross-stream
cursor cannot restart from zero or reveal another stream. The query returns
only event/payload digests, sequence, receipt state, and acknowledgment state;
it performs no send, ACK, receipt transition, retention, or prune action.

Before slicing a page, Q2 validates the exact stream's stored sequence,
digest, receipt, and ACK invariants and requires a non-initial cursor to name
an event that still exists. This is intentionally not a performance claim;
bounded retention and pruning remain separate work.

This proves only the inline SQLite outbox read. It does not prove the future
FIFO worker's durable-commit ACK ordering and therefore checks neither 488 nor
489. Graph query, broker runtime/HTTP, the broad adapter interface,
`stateContract`, serving-store promotion, primitive integration, migration,
performance, deployment, and issue closure remain outside Q2.

### Slice Q3 — SQLite graph evidence-path query only

Q3 adds `queryGraphEvidencePath` to the same closed SQLite query dispatcher.
It reads only the durable `shared_state_graph_source`, graph batch, and
projection checkpoint rows; it does not reuse the ordinal-based test-only
conformance control. The broad async `SharedStateStorageAdapterV1`, broker
runtime, and HTTP surface remain unchanged.

The query opens `BEGIN IMMEDIATE` and verifies the current owner token and
lifecycle epoch inside that transaction before reading graph state. A busy
writer returns closed `lock_timeout`; changed ownership returns closed
`lost_ownership`; unreadable or malformed durable authority returns closed
`authority_unavailable`. The successful envelope always reports Q1's exact
`monotonic-eventual` / `projection-batch` consistency.

Before answering, Q3 validates the exact namespace's source-fact and
source-stream digest domains, typed node vocabulary, contiguous canonical
source sequence, selected projection checkpoint, batch/inverse digest domains,
and the live batch lineage from checkpoint zero to the selected checkpoint.
It refuses a checkpoint above source high-water, a gap or fork in live batch
lineage, a non-canonical decimal, or a batch range outside durable source
truth. This whole-ledger validation is a correctness boundary, not a
performance claim.

The evidence graph follows the storage shape already committed by the SQLite
projection slice: every live batch contributes one edge from its first source
sequence to each later sequence in that batch. A deterministic bounded search
returns only source-fact digests. A path may be reported at an incomplete
checkpoint with `completeness=incomplete`; absence becomes
`no_evidence_path` only when checkpoint equals source high-water. Otherwise it
returns `projection_incomplete` with exact checkpoint, high-water, and lag.
Rollback removes the rolled-back batch from the derived path while preserving
immutable source facts and exposes the restored, possibly incomplete,
checkpoint.

The current SQLite ledger has no durable projection-authority marker, so Q3
does not invent a successful `projection_unavailable` graph result. Database
or ownership inability instead uses the closed unavailable envelope. Because
the full Phase 2.7 matrix still cannot be driven through a durable
`projection_unavailable` state, its repeat item remains unchecked.

Q3 checks no 488/489 item and adds no FIFO worker, serving-store promotion,
primitive integration, `stateContract`, retention/prune, migration,
performance, deployment, or issue closure.

### Decision Q4 — promote the closed query union to the broad async contract

Owner decision Q4 (2026-08-24 KST, `#1504`): Q1 now defines both closed query
families and Q2/Q3 implement both against the inline SQLite adapter. The next
source slice may therefore add the query member that section 6.1 has always
planned to the broad backend-neutral interface:

```text
query(request: SharedStateQueryRequestV1)
  -> Promise<SharedStateQueryResultV1>
```

This promotes exactly the existing `reconcileOutbox` and
`queryGraphEvidencePath` union. It does not add a generic SQL/read command,
metadata or health query, replay/rate/lease/idempotency preflight read, a
test-only conformance control, or a third operation. Adding another operation
requires another closed contract and owner decision.

The parse boundary and the result boundary remain distinct. An untyped caller
must first use `parseSharedStateQueryRequestV1`; a parser rejection remains a
closed parser error and is never converted into a query result with an
invented operation. The broad member accepts only a successfully parsed
`SharedStateQueryRequestV1`. Implementations still validate defensively, but a
request that cannot identify one of the two registered operations cannot be
made to look like either operation succeeded or became unavailable.

After a valid request enters `query`, every ordinary storage or lifecycle
inability resolves to an operation-preserving `SharedStateQueryResultV1` with
`status=unavailable`, `achievedConsistency=null`, and the existing bounded
query reason vocabulary. It must not escape the SQLite-local
`{ok:false,error}` wrapper through the broad contract, reject merely because a
backend is synchronous, or return a weaker successful consistency. Busy,
ownership-loss, authority, and genuinely observed unsafe-clock conditions map
only to their existing closed reasons; no reason is inferred when its
condition was not observed.

The broad member is asynchronous because a future shared backend may require
network I/O. The current SQLite dispatcher may remain synchronous behind the
normalization seam; wrapping that completed local result in a promise changes
neither its `BEGIN IMMEDIATE` serialization boundary nor its consistency
claim. This decision does not make `SharedStateSqliteAdapterV1` claim the full
section 6.1 interface or conformance: its other planned broad lifecycle,
metadata, transaction-callback, and health surfaces remain separate work.

The next reviewed source slice is limited to the broad interface member, the
narrow SQLite normalization seam, and focused type/runtime fail-closed tests.
It does not wire a broker caller or HTTP route, select a serving store, move a
primitive source of truth, retire a legacy authority, change `stateContract`,
or alter a default. Those require a later owner decision naming one primitive,
one authoritative store, its shadow comparison, and its legacy retirement
rule.

Q4 proves neither FIFO durable-commit ACK ordering nor worker-backed read
consistency, so 488/489 remain unchecked. It authorizes no FIFO worker,
serving-store promotion, primitive integration, retention/prune, migration,
performance claim, deployment, live action, or issue closure.

### Slice Q5 — broad async query member and SQLite normalization only

Q5 adds the Q4-authorized `query(request) -> Promise<result>` member to
`SharedStateStorageAdapterV1`. Its input and output are exactly the Q1
`SharedStateQueryRequestV1` and `SharedStateQueryResultV1` unions. No generic
read command or third query operation is added, and the interface remains a
planned structural contract rather than a claim that the current SQLite class
implements every section 6.1 member.

`packages/broker/src/shared-state-sqlite-query-surface-v1.ts` is the separate
normalization seam. It exposes only `Pick<SharedStateStorageAdapterV1,
"query">`, wraps the existing synchronous SQLite dispatcher in the required
promise, and leaves `SharedStateSqliteAdapterV1` and its transaction/ownership
boundaries unchanged. Nothing imports the seam into broker runtime.

An untyped or malformed request is rejected with the existing closed parser
error before the dispatcher is called; no operation is invented to create an
unavailable result. Once a valid request enters, the seam returns only a
validated operation-matched query result. A SQLite-local `ownership_lost`
wrapper becomes closed `lost_ownership`; every other local wrapper failure,
throw, malformed result, or crossed-operation result becomes closed
`authority_unavailable`. Closed reasons the SQLite query already observed —
including `lock_timeout`, `lost_ownership`, and `unsafe_clock` — pass through
only after full result parsing. The local `{ok:false,error}` wrapper never
crosses the broad interface.

Focused tests pin the Promise shape, the query-only surface, both operation
families, parser-before-dispatch behavior, every SQLite-local error code,
closed reason preservation, thrown/malformed/crossed fail-closed behavior, and
a real not-ready SQLite dispatcher. This slice does not add a broker caller or
HTTP route, promote a serving store, claim full adapter conformance, move a
primitive source of truth, retire a legacy authority, change `stateContract`,
or alter any default.

Q5 still proves neither FIFO durable-commit ACK ordering nor worker-backed
read consistency, so 488/489 remain unchecked. It adds no FIFO worker,
primitive integration, retention/prune, migration, performance claim,
deployment, live action, or issue closure.

### Decision W0 — V1-owned FIFO writer and query ordering

Owner decision W0 (2026-08-24 KST, `#1504`): inline SQLite conformance and
the two-operation query surface now exist, so a later source slice may open the
worker-writer proof lane that decision C left closed. This decision records the
lane only. It adds no worker source and checks neither 488 nor 489.

The existing
`packages/broker/src/core/sqlite-worker-thread-persistence.ts` is not the V1
worker. It owns the legacy `SqliteBrokerStateStore` file and schema, keeps
main-thread read connections, and preserves void-typed call sites that may use
fire-and-forget writes. Importing that proxy, sharing its connection, or
placing the V1 file behind it would not prove the V1 transaction, ownership,
clock-floor, result-parser, or ACK boundaries. `plan.md`'s instruction to
reuse the optional FIFO worker therefore means reuse the bounded single-FIFO
architecture and opt-in posture, not the legacy module, protocol, database,
or runtime flag.

Worker mode has exactly one V1 SQLite authority. The worker owns the V1
database connection, `SharedStateSqliteAdapterV1` instance, lifecycle epoch,
and ownership token for that mode. The main thread must not open a second V1
adapter or bypass the worker for a query. A new purpose-bound protocol carries
only the existing closed transaction commands, the two closed Q1 query
requests, lifecycle controls, and the adapter-owned trusted time observation
needed by a command. Caller clock fields, arbitrary SQL, backend commands,
generic method names, and protocol extensions remain forbidden. Both sides
validate the closed envelope defensively. The broad
`withTransaction(callback)` function is never serialized or transferred to
the worker; a narrow closed-command worker surface does not by itself
implement or conform to the full broad adapter interface.

One bounded FIFO lane serializes every accepted transaction command and query.
Admission assigns a monotonically increasing process-local ticket only after
the request passes its closed parser and a queue slot is available. A rejected
parse, saturated/closing queue, unavailable worker, or failed lifecycle is not
an accepted write and returns the existing closed failure or
operation-preserving unavailable result. The ticket is scheduling evidence
only: it is not durable state, an outbox sequence, an outbox receipt/ACK, an
idempotency key, or a public field.

A transaction promise may report a committed result only after the worker's
SQLite `COMMIT` has completed and the worker has returned the result for that
ticket. A domain rejection or rollback must likewise have a known terminal
result before its ticket settles. Transport loss, worker exit, timeout, or a
malformed/crossed response after dispatch is ambiguous: the proxy must not
invent a rollback, retry the command, or report a committed result. It fails
the worker surface closed and returns unavailable through the existing result
family where one can be identified.

A query takes its serialization point from its position in the same FIFO. It
executes on the worker-owned adapter only after every earlier accepted command
has reached a known committed or rolled-back result. The main thread must not
resolve a successful query before the durable-commit ACKs for all earlier
committed tickets have crossed the worker boundary. If the barrier or worker
authority cannot be proved, the query returns its operation-preserving
`status=unavailable` result; it does not perform a main-thread stale read or
weaken the requested consistency. Writes admitted after the query are outside
that query's serialization point. This ACK is internal persistence evidence
and remains unrelated to terminal-outbox receipt or acknowledgment.

Worker failure rejects queued work, makes unresolved dispatched writes
ambiguous, and makes later queries unavailable. It must not silently create a
replacement authority or reopen the file. Adapter `drain` is also distinct
from the broker `beginDrain` path prohibited for `lost_fence`: it closes
admission, waits for every accepted ticket to reach a known terminal result,
and succeeds only when no ambiguous write remains. A timeout or crash fails
drain closed. `close` may ask the worker-owned adapter to release ownership
only after a successful drain; forced termination is not a clean close and
must not claim that ownership was released.

Implementation follows as separately reviewed source slices. The first may
add only the purpose-built protocol, bounded FIFO proxy/worker, and focused
temporary-database tests for parser-before-admission, capacity, exact order,
COMMIT-before-ACK, query barriers, known rollback, ambiguity, crash,
drain/close, and both existing query families. It must remain detached from
broker runtime and may not claim the full broad adapter interface merely
because a narrow worker surface exists. A later slice must run every applicable
V1 deterministic conformance/failure suite through worker mode before 488 can
be checked. 489 additionally requires focused proof that a query cannot
resolve successfully across a delayed or missing earlier durable ACK. Neither
box is checked on protocol shape, queue FIFO tests, or inline evidence alone.

W0 authorizes no runtime/HTTP import, existing persistence-worker change,
configuration flag, default, serving-store selection, primitive source-of-
truth move, legacy retirement, `stateContract` change, retention/prune,
migration, performance claim, deployment, live action, or issue closure.

### Slice W1 — the purpose-built protocol and the bounded FIFO lane

This is the first source slice decision W0 authorized, and it is the only part
of that decision it implements. It adds four modules and one test file under
`packages/broker/src/`, and it changes no existing source.

`shared-state-sqlite-worker-protocol-v1.ts` is the closed wire contract. It
carries the existing closed transaction commands, the two existing closed Q1
query requests, the three lifecycle controls `open`/`drain`/`close`, and a
process-local ticket. It carries nothing else. Payload members are structurally
`unknown` on the envelope and are then run through the real contract parsers on
both sides, so a caller clock field, a backend command, or a sensitive field is
refused by the same rules that already govern the inline path rather than by a
second, weaker copy of them. The five command names are the adapter's own
member names, not generic method names, and the envelope is `.strict()` in both
directions.

The broad `withTransaction(callback)` member is absent from the protocol by
construction. Its callback and the `SharedStateStorageTransactionV1` it
receives are functions, so structured clone cannot carry them, and holding a
SQLite transaction open across message round-trips is not this lane's shape. It
is never serialized and never transferred.

`shared-state-sqlite-worker-entry-v1.ts` is the single V1 authority for its
file in worker mode. It owns the `DatabaseSync` connection, the
`SharedStateSqliteAdapterV1` instance, the lifecycle epoch, and the ownership
token. It does not import, extend, or share a connection with
`core/sqlite-worker-thread-persistence.ts`; it does not touch the legacy
`SqliteBrokerStateStore` file, schema, protocol, or runtime flag; and the main
thread holds no read connection of its own. The trusted time observation that
`transact` requires is taken inside this thread, immediately before execution,
which is why no clock field appears on the wire.

`shared-state-sqlite-worker-lane-v1.ts` is the bounded FIFO. A ticket is
assigned only after the request clears its closed parser and a queue slot is
available, and exactly one request is in flight at a time, so a query's
serialization point is its queue position. A rejected parse has no operation to
preserve and returns the existing closed adapter failure; a saturated or
closing queue, an unavailable worker, or a failed lifecycle returns the
operation-preserving `unavailable` result, because in those cases the operation
is known. The ticket never appears in a returned contract envelope and is not
durable state, an outbox sequence, an outbox receipt or acknowledgment, or an
idempotency key.

A transaction promise reports `committed` only after the adapter's `transact`
returned — which is after SQLite `COMMIT` — and after the worker's response for
that exact ticket crossed back. Transport loss, worker exit, acknowledgment
timeout, and a malformed or crossed response after dispatch are all ambiguous:
the lane records the ambiguity, returns `unavailable`, and never invents a
rollback, retries the command, or reports a commit. Because a later query could
not then prove that every earlier accepted command reached a known committed or
rolled-back result, the lane stops serving after an ambiguity instead of
performing a main-thread stale read or weakening the requested consistency. It
creates no replacement authority and never reopens the file. `drain` closes
admission, waits for accepted tickets to settle, and fails closed on a timeout,
a crash, or any remaining ambiguity; `close` asks the worker-owned adapter to
release ownership only after that successful drain, and a forced termination
never claims ownership was released.

`shared-state-sqlite-worker-channel-v1.ts` is the only module that touches
`node:worker_threads`. It resolves the compiled entry as a sibling of itself,
the same mechanic the repository's one existing production worker uses, so the
lane itself can be driven by a substitute channel.

The test file proves both levels on purpose. A substitute channel drives
capacity, exact dispatch order, crossed responses, acknowledgment timeout,
worker loss, the query barrier, drain timeout, and unclean close, because those
fail-closed rules are not reliably reproducible against a real thread and a
flaky proof of a fail-closed rule is worse than none. A real worker thread
drives open, commit-before-acknowledgment verified by an independent reader on
the same file, a real domain rejection, both closed query families, and
ownership release through drain then close, because those are exactly the
claims a substitute channel could fake.

Two defects were found and fixed by these tests before publication. A forced
`terminate` left an already dispatched ticket permanently unsettled instead of
declaring it ambiguous. And the acknowledgment and drain timers were `unref`ed,
so a lane holding an unsettled write could let the process exit quietly and the
ambiguity would never be declared; a dispatched-but-unsettled write is exactly
the state in which that must not happen, and the timers are cleared when the
ticket settles.

W1 checks neither 488 nor 489, and this record checks no box. It runs no V1
deterministic conformance or failure suite through worker mode, which 488
requires, and it proves no delayed-or-missing-earlier-ACK query case beyond the
single-lane barrier asserted here, which 489 requires. It claims no conformance
to the broad `SharedStateStorageAdapterV1` interface: a narrow closed-command
worker surface does not implement that interface merely by existing, and the
lane is deliberately not declared as implementing it. It adds no broker
runtime or HTTP import, existing persistence-worker change, configuration flag,
default, serving-store selection, primitive source-of-truth move, legacy
retirement, `stateContract` change, retention/prune, migration, performance
claim, deployment, live action, or issue closure.

### Slice W2a — worker-mode conformance scaffolding and the first harness

Decision W0 says a later slice must run every applicable V1 deterministic
conformance/failure suite through worker mode before 488 can be checked. That
is not a single slice. The seven inline SQLite targets are 550 to 1,200 lines
each, and one pull request carrying worker-mode counterparts for all of them
would be unreviewable. W2a therefore builds the shared scaffolding and moves
exactly one harness onto it; the remaining six follow as separate slices, and
neither 488 nor 489 is checked by any of them until the last.

Phase 2.6 was chosen first because it is the only harness with no statement
proxy at all: its controls are plain out-of-band SQL. That makes it the honest
test of whether the scaffolding works, rather than a test of how clever the
fault seam is.

Four judgments were required to write this, and they are recorded here because
they were made by the implementer rather than by an owner decision packet.

**Judgment 1 — how fault injection and observation reach the worker.** Both
travel over a new conformance control family in
`shared-state-sqlite-conformance-control-v1.ts`. It is not an extension of the
lane protocol: that protocol stays exactly as W0 fixed it, with five commands
and no test affordance. Control messages ride the same port but are a separate,
separately parsed family, and the conformance channel filters them out before
the lane sees them — the lane treats an unrecognised envelope as a crossed
response, so a leaked control reply would declare an unrelated ticket ambiguous.
The control set is closed and enumerated rather than an SQL channel, so the
out-of-band access each harness needs is a reviewable list. Sending a control to
the production worker does nothing: that entry cannot correlate a message with
no ticket and answers nothing. The test affordances live in a second worker
build, `shared-state-sqlite-conformance-worker-entry-v1.ts`; the shipped entry
imports none of it. Both builds serve the lane protocol through the same
extracted `shared-state-sqlite-worker-runtime-v1.ts`, so a conformance run
exercises the request handling that production runs.

**Judgment 2 — the main-thread raw read handle is not needed, so it is not
taken.** W0 forbids opening a second V1 adapter and bypassing the worker for a
query, and it is genuinely ambiguous whether a test-only raw read handle for
conformance snapshots falls under that. The ambiguity is avoided rather than
resolved: because observation already has to travel for the controls, the
snapshot travels with it. A worker-mode target opens no `DatabaseSync` and holds
no raw handle, so the worker remains the single authority for its file and no
interpretation of W0 is required. This is a stronger position than the inline
targets hold.

**Judgment 3 — the observed instant is injected into the worker, not carried on
the protocol.** This was not visible until a clock-bearing harness was wired up.
W1's worker reads `Date.now()`, which honours W0's prohibition on caller clock
fields but cannot express `expiry - 1`, `expiry`, `expiry + 1` — the boundaries
Phase 2.6 probes exactly, and which Phases 2.1, 2.2, and 2.4 also depend on. The
runtime now takes its clock as a constructor input. The production entry passes
the real one; the conformance build passes a deterministic one it drives through
a control. The observation is still made by the thread that owns the adapter, at
execution time, and no clock field appears on the lane protocol or on any
command, so the prohibition holds as written and as intended.

**Judgment 4 — the harnesses' sync `void` controls are satisfiable.** Every
harness arms faults and applies controls through methods typed `: void` that it
does not await, so a worker implementation cannot confirm delivery. Controls and
lane requests share one `MessagePort` and `postMessage` delivery is ordered, so
a control posted before the next lane request is applied before that request
executes. The ordering guarantee, not an acknowledgment, is what makes these
methods work; no harness signature changed.

The Phase 2.6 snapshot builder was extracted from the inline target into
`shared-state-sqlite-expiry-snapshot-v1.ts` and both modes now call it. Two
copies of that SQL would let the two modes' evidence drift apart silently, and a
worker-mode pass would stop meaning what an inline pass means. The extraction
changed no behaviour: the inline Phase 2.6 target still passes unchanged.

Still open, and deliberately not judged here: Phase 2.5 needs a second rival
connection on the same file taking `BEGIN IMMEDIATE`, plus out-of-band ownership
rewrites. Whether that rival belongs inside the worker, beside it, or is
inapplicable to worker mode is a question for the slice that moves 2.5, and
nothing here presumes an answer.

W2a checks neither 488 nor 489 and this record checks no box. Six harnesses run
inline only, and no delayed-or-missing-earlier-ACK query case is proved. It adds
no broker runtime or HTTP import, existing persistence-worker change,
configuration flag, default, serving-store selection, primitive source-of-truth
move, legacy retirement, `stateContract` change, retention/prune, migration,
performance claim, deployment, live action, or issue closure.

### Slice W2b — Phase 2.2 through the worker lane, and what 2.6 could not surface

Phase 2.2 is the second harness onto the W2a scaffolding. It was chosen next
because 2.6 has no statement proxy at all, so W2a built the fault seam and the
`readFaultState` control without ever exercising them. 2.2 arms four statement
faults and asks whether each fired, which is the first real test of both.

Moving one harness at a time paid for itself here: three defects surfaced that
2.6 structurally could not have shown.

**The observed instant had to become a queue, not a slot.** W2a published an
instant to the worker and then admitted the command. Phase 2.2 submits
sixty-four same-fingerprint contenders at once, so a later caller's instant
overwrote an earlier caller's before the worker executed the earlier command.
Each target publishes its instant immediately before admitting its command, in
the same synchronous step, so publication order and lane admission order are the
same order; consuming one instant per command therefore pairs each command with
the instant its caller intended. An empty queue now fails the command closed
rather than reusing a stale instant, because reusing one would answer with a
silently wrong observation that no conformance suite can detect. Phase 2.6 is
sequential and never exposed this.

**The lane queue must be at least as deep as the harness's peak concurrency.**
With a queue of sixteen against sixty-four contenders, the lane answered the
surplus with an operation-preserving `unavailable` result. That is correct lane
behaviour and indistinguishable, to a harness, from an adapter that gave
identical requests different outcomes. Both worker-mode targets now size their
queue from the harness's own declared operation count, which keeps the queue a
scheduling detail rather than a silent participant in the proof. The inline
targets have no queue, so nothing could have surfaced this before worker mode.

**A clean close cannot be reopened in place, and should not be.** Every harness
closes a target and reopens it. An inline target reopens an adapter that still
holds its connection. Worker mode cannot: a clean close releases ownership and
terminates the thread, and the lane refuses to reopen a closed lane by design,
because a lane that quietly reopened would be creating the replacement authority
W0 forbids. A reopen therefore spawns a new worker against the same file, which
is a stronger proof than the inline reopen rather than a weaker one — the new
worker must acquire ownership from scratch, which only succeeds if the previous
close really released it. That lifecycle now lives in
`shared-state-sqlite-worker-conformance-session-v1.ts` so the five remaining
harnesses cannot each get ownership release subtly wrong.

**How a fired fault is observed.** The inline target shares a boolean with its
own proxy and resets it before each command. The proxy is in the worker here, so
the target compares the worker's monotonic fired count before and after instead.
A count survives a race that a reset flag does not: if a fault fires between the
reset and the read, a flag reports the wrong transaction while a count still
reports the right delta.

**One unrelated test was repaired.** `shared-state-loss-monitor-v1.test.ts`
asserted that two 20 ms timer probes land inside a fixed 70 ms sleep. That
assumption stopped holding as the broker suite grew worker threads: it failed
once during W1 and twice consecutively here, without the monitor ever being
wrong. It now polls for the probes to a generous deadline, which keeps the claim
and still fails if the timer never fires. This slice made a latent flake
systematic, so it is repaired here rather than left for the next slice to
rediscover.

W2b checks neither 488 nor 489 and this record checks no box. Five harnesses run
inline only — outbox, restart-continuity, partition, claim-graph, and lease — and
no delayed-or-missing-earlier-ACK query case is proved. Phase 2.5's rival
connection remains unjudged. It adds no broker runtime or HTTP import, existing
persistence-worker change, configuration flag, default, serving-store selection,
primitive source-of-truth move, legacy retirement, `stateContract` change,
retention/prune, migration, performance claim, deployment, live action, or issue
closure.

### Slice W2c — Phase 2.3 through the worker lane

Third harness onto the W2a scaffolding, and the first whose out-of-band surface
is a row set rather than a scalar. Phase 2.3 derives both its snapshot and its
reconciliation response from the same committed rows, so worker mode fetches
those rows once through one `outboxRows` control and derives both on the main
thread, exactly as the inline target derives both from one raw query. Deriving
them from two separate reads would let a snapshot and a reconciliation disagree
about what was committed, which is the specific confusion this harness exists to
catch.

The scaffolding needed one addition and no changes. Phase 2.3 is the first
harness with an adversarial reopen that binds to a different database: inline it
constructs a fresh `DatabaseSync`, and in worker mode it must spawn a worker
against a different file. The session now exposes that as
`rebindFilePathForViolation`, named so it cannot be mistaken for ordinary
lifecycle. Nothing in a passing run calls it. Worker mode strengthens this
particular violation rather than weakening it: the observation surface lives in
the same worker that holds the connection, so a target cannot lose state and
keep reporting the old rows.

The inline target holds two handles against the same file, `reads` and `writes`.
Worker mode collapses both into the worker that owns the connection, so the
worker-mode target holds none. Everything W2b established carried over
unchanged: the instant queue, harness-derived queue sizing, the reopen-capable
session, and observing a fired fault by monotonic count rather than a reset
flag.

W2c checks neither 488 nor 489 and this record checks no box. Four harnesses run
inline only — restart-continuity, partition, claim-graph, and lease — and no
delayed-or-missing-earlier-ACK query case is proved. Phase 2.5's rival
connection remains unjudged. It adds no broker runtime or HTTP import, existing
persistence-worker change, configuration flag, default, serving-store selection,
primitive source-of-truth move, legacy retirement, `stateContract` change,
retention/prune, migration, performance claim, deployment, live action, or issue
closure.

### Slice W2d — Phase 2.7 through the worker lane

Fourth harness onto the W2a scaffolding, and the first whose out-of-band
surface is *derived* state rather than stored state. Phase 2.7's snapshot and
its evidence-path probe both compute over the same live batches, checkpoint, and
source high-water mark, and the derivation is the thing under test: which
batches count, what completeness means, and whether a negative judgment is
permitted at all. Worker mode fetches that state once through one
`claimGraphState` control and performs every derivation on the main thread,
exactly where the inline target performs it. Two reads would let the snapshot
and the probe disagree about the projection, which is the confusion this
harness exists to catch — the same reason `outboxRows` is one read in W2c.

One placement decision was not obvious and is recorded because it could have
been made wrongly. The target keeps an `authorityUnavailable` flag that an
injected fault sets and the next clean command clears. It is target-owned state
rather than a database row, so it would have been natural to move it into the
worker alongside the fault seam that triggers it. That would have been a
mistake: the `authorityStaysAvailableAfterFault` violation exists to prove the
harness catches a target that keeps reporting an available authority after a
real fault, and a worker cannot know that a target chose to lie about it. The
flag stays on the main thread, so the violation stays reachable. The general
rule this instance illustrates: state whose *misreporting* is what a violation
simulates has to live where the simulation lives.

The scaffolding needed one control and no changes. Everything W2b and W2c
established carried over: the instant queue, harness-derived queue sizing, the
reopen-capable session, observing a fired fault by monotonic count, and
deriving many answers from one read.

Worker mode does not re-prove where in the statement stream the seam fires. The
inline target asserts that against its own `preparedSql` log, and it is a
property of the adapter's SQL order rather than of the lane, so it is left
where it already holds.

W2d checks neither 488 nor 489 and this record checks no box. Three harnesses
run inline only — restart-continuity, partition, and lease — and no
delayed-or-missing-earlier-ACK query case is proved. Phase 2.5's rival
connection remains unjudged. It adds no broker runtime or HTTP import, existing
persistence-worker change, configuration flag, default, serving-store selection,
primitive source-of-truth move, legacy retirement, `stateContract` change,
retention/prune, migration, performance claim, deployment, live action, or issue
closure.

### Slice W2e — Phase 2.4 through the worker lane, and isolating worker-mode load

Fifth harness onto the W2a scaffolding, and the hardest. Phase 2.4 is the first
that crashes a target and reopens it with no close of its own, and the first
that compares whole snapshots across a restart by JSON string. Both press on the
lane's lifecycle rather than its transaction path, and three things had to be
settled that no earlier slice reached.

**A failed adapter is invisible to the lane, so the target restarts it.** After
the forbidden backward-clock write the adapter rolls back and marks itself
failed, and refuses everything afterwards. The lane cannot see that: the refusal
arrives as an ordinary operation-preserving `unavailable` result value, not as a
lane error, so the lane keeps believing it is ready and answers the harness's
next `open` with `already_open`. The target now tears the worker down when it
sees `unsafe_clock`, which is the worker-mode equivalent of the inline adapter
being left failed — what follows a failed authority is a restart.

**W0's close rule is kept rather than relaxed to match inline.** In the same
scenario `drain` legitimately refuses, and the inline target simply closes
anyway, releasing ownership. Decision W0 does not permit that here: `close` may
ask the worker-owned adapter to release ownership only after a successful drain.
So this target tears the worker down without claiming ownership was released,
and the reopen re-acquires with the same owner token. That is what an unclean
shutdown followed by a restart actually looks like, and it was verified
empirically before being relied on.

**Observation has to survive a crash.** The harness snapshots between a crash
and the reopen that follows it, when no lifecycle is held. The session now
exposes an observation channel that spawns a worker without opening the lane on
it. Controls read the raw connection and do not require an open adapter, so this
observes without acquiring ownership.

**Worker-mode suites moved to their own serial manifest step.** These suites
spawn real worker threads, and Phase 2.4 respawns one per simulated crash.
Inside the `--test-concurrency=12` step that load pushed the `/health` p50 and
p99 latency budgets past their thresholds — four manifest failures, none of them
in the code under test. Those budgets guard something real, so they were not
relaxed; the load was isolated instead. The suites now live in
`packages/broker/src/shared-state-worker-mode/` and run as their own serial
step after the concurrent one, which removed three of the four failures.

The fourth is a property of the machine rather than of the change: this node has
two CPUs, the concurrent step requests twelve, and the remaining failure was a
p50 of 31.4 ms against a 30 ms budget at load average 7.5. The same manifest
passed with `exit 0` on a rerun at load average 4.5, and the health suite passes
14/14 in isolation. Recorded rather than smoothed over, because the honest
statement is that this node cannot hold that budget under that concurrency, not
that the budget is wrong.

W2e checks neither 488 nor 489 and this record checks no box. Two harnesses run
inline only — partition and lease — and no delayed-or-missing-earlier-ACK query
case is proved. Phase 2.5's rival connection remains unjudged. It adds no broker
runtime or HTTP import, existing persistence-worker change, configuration flag,
default, serving-store selection, primitive source-of-truth move, legacy
retirement, `stateContract` change, retention/prune, migration, performance
claim, deployment, live action, or issue closure.

### Slice W2f — Phase 2.1 through the worker lane

Sixth harness onto the W2a scaffolding, and the first that needs two
authorities at once. Phase 2.1 opens a second owner against the same file and
requires the adapter — not the target — to refuse it, which is the whole proof
that the singleton is exclusive.

Worker mode expresses that as two sessions on one file with different owner
tokens. No session change was needed: a session is already parameterised by
file and token, so two of them is the natural spelling. The arrangement is
stronger than the inline one rather than merely equivalent, because the refusal
now crosses a real thread boundary between two separately owned connections
instead of occurring between two objects sharing an address space.

One control was added for a reason worth stating. The harness requires the
refused owner to have reached a failed state, and the lane's own state is not a
substitute for that. The lane failing alongside its adapter is a coincidental
fact; the claim under test is about the adapter. So `adapterLifecycle` reports
the worker-owned adapter's real lifecycle and the target asserts on that. The
same instinct that kept `authorityUnavailable` on the main thread in W2d
applies here in the opposite direction: the assertion has to read the thing it
is actually about.

The two `after_` fault points map to the seam's `after-run` phase, so the lease
row is really written before the fault fires. Mapping them to `before-prepare`
would have made them `before_mutation` under another name, and the harness
would have reported atomicity it never tested — the inline target's own comment
warns about exactly that, and the descriptor test now asserts the mapping.

Everything W2b through W2e established carried over unchanged.

W2f checks neither 488 nor 489 and this record checks no box. Phase 2.5
partition runs inline only, and no delayed-or-missing-earlier-ACK query case is
proved. Phase 2.5's rival connection remains unjudged and is the last open
question before 488 can be considered. It adds no broker runtime or HTTP
import, existing persistence-worker change, configuration flag, default,
serving-store selection, primitive source-of-truth move, legacy retirement,
`stateContract` change, retention/prune, migration, performance claim,
deployment, live action, or issue closure.

### Decision W3 — the Phase 2.5 rival connection in worker mode

Six of the seven Phase 2 harnesses now run through the worker lane. Phase 2.5
partition is the last, and W2a deliberately left one question about it
unjudged: its target needs a second rival connection on the same file taking
`BEGIN IMMEDIATE`, and whether that rival belongs inside the worker, beside it,
or is inapplicable to worker mode was not something a scaffolding slice should
have decided. This records the boundary only. It adds no source and checks
neither 488 nor 489.

**What Phase 2.5 actually requires.** Its five fault points are not equally
novel, and four of them are already-solved shapes:

- `unavailable` rewrites `owner_token` to a foreign value — an out-of-band
  `UPDATE`, the same shape as every violation control since W2a.
- `lost-fence` advances `lifecycle_epoch` past the session — likewise.
- `ambiguous-commit` fires at `COMMIT` — the existing seam's `before-exec`
  phase, already exercised by Phases 2.2, 2.3, and 2.4.
- `delayed-read` establishes nothing; the projection lag is already stored.
- `timeout` takes a `RESERVED` lock from a second connection so the adapter's
  own `BEGIN IMMEDIATE` raises a real busy error.

Only the last is new. The question is therefore narrower than it looked: not
"how do we move Phase 2.5", but "where does one rival connection live".

**The decision: the rival lives inside the conformance worker.** It is a bare
second `DatabaseSync` on the same file, opened by the conformance build,
controlled by test-only controls, and it is never a second V1 adapter. The
worker remains the single V1 authority for its file.

Two alternatives were considered and are not chosen. Opening the rival on the
main thread would reintroduce exactly the main-thread database handle that
every worker-mode slice since W2a has avoided, and it would do so for the one
harness whose subject is contention — the place where an extra unowned
connection is least defensible. Declaring the rival inapplicable to worker mode
would hollow out the harness: `timeout` is the only point that produces a real
`SQLITE_BUSY`, and a Phase 2.5 run without it would report partition tolerance
it never tested, which is the precise failure mode the inline target's own
header warns about.

**This was verified before being decided, not after.** A second connection in
the same thread does collide: with the rival holding `BEGIN IMMEDIATE`, the
owning connection's `BEGIN IMMEDIATE` fails with `database is locked`, that
message matches the adapter's existing busy detection and therefore maps to
`lock_timeout` rather than a generic failure, and the owner re-acquires cleanly
after the rival rolls back, so healing works. SQLite locking is per-connection
rather than per-process, which is why sharing a thread does not weaken the
collision.

**Why this stays inside decision W0.** W0 forbids the main thread opening a
second V1 adapter and forbids bypassing the worker for a query. A rival
connection inside the worker is neither: it is not on the main thread, it is
not an adapter, it answers no query, and it exists only to make the owning
adapter's own `BEGIN IMMEDIATE` fail the way a partitioned store would. It is
the same object the inline target already uses, moved to the side of the
boundary that owns the file.

**What the following source slice may add.** Only the worker-mode Phase 2.5
target, the rival connection in the conformance build, and the controls that
establish and heal the five fault points. It must not relax the lane's rules to
make the harness pass, must not open a main-thread handle, and must not extend
the closed lane protocol. If the harness cannot be satisfied within those
limits, that is a finding to record rather than a rule to bend.

This decision authorizes no source, no runtime/HTTP import, no existing
persistence-worker change, no configuration flag, default, serving-store
selection, primitive source-of-truth move, legacy retirement, `stateContract`
change, retention/prune, migration, performance claim, deployment, live action,
or issue closure. It checks neither 488 nor 489, and it does not by itself make
488 checkable: that still requires the Phase 2.5 slice to land and, separately,
489 requires focused proof that a query cannot resolve successfully across a
delayed or missing earlier durable ACK.

### Slice W4 — Phase 2.5 through the worker lane, completing the seven

The last harness, implemented under the boundary decision W3 fixed. All seven
Phase 2 conformance harnesses now run through the worker lane, unmodified, with
every adversarial violation still failing closed.

Decision W3 is what made this tractable. The rival connection lives inside the
conformance worker as a bare second `DatabaseSync`, so the `timeout` premise is
a real `RESERVED` lock colliding with the adapter's own `BEGIN IMMEDIATE`
rather than a simulated refusal, and no main-thread handle exists — not even
for the one harness whose subject is contention. The other four points were the
shapes earlier slices had already solved.

**The synchronous arm needed a place to put failures.** `armConformanceFault`
is typed `: void` and the harness never awaits it, yet in worker mode it must
heal the previous premise, install the new one, and for the two ownership
points drive the adapter's own `beginWrite` guard so the premise is genuinely
observed. Message ordering makes that work land before the next lane request,
but a failure inside it cannot be thrown back at a caller that has already
returned. The worker records it and the next awaited control surfaces it. That
is where the harness would notice in any case, and it is strictly better than
letting the failure vanish — a silently un-established premise would let the
run report partition tolerance it never exercised.

**Every refusal is a real adapter boundary.** `ownership_lost` comes from the
adapter re-reading the ownership row; `store_failure` comes from a genuinely
busy store or a throwing `COMMIT`. The target asserts which boundary produced
each refusal rather than assuming it, exactly as the inline target does, and it
re-establishes the ownership premises per command so each refusal is a fresh
check inside the adapter rather than a cached verdict.

Two mistakes are recorded because both failed quietly rather than loudly. The
stale-read control was first written from the harness's schema rather than the
inline target's construction, which dropped `completeness` and
`asOfSourceSequence` and passed a decimal string where a number belongs; the
harness reported a control failure, not a shape error. And the target initially
did not seed provenance sources in `open()`, so checkpoint and high-water were
equal, the stale answer read as `complete`, and the run failed as though the
target had mislabelled a stale read when in fact it had never created the lag
the harness measures.

**What this does not do.** It checks neither 488 nor 489. Checking 488 is a
separate judgment about whether seven passing worker-mode harnesses satisfy
"every applicable V1 deterministic conformance/failure suite" as W0 worded it,
and that judgment belongs in its own record rather than being taken here by the
slice that would benefit from it. 489 additionally needs focused proof that a
query cannot resolve successfully across a delayed or missing earlier durable
ACK, which nothing in W1 through W4 provides. It adds no broker runtime or HTTP
import, existing persistence-worker change, configuration flag, default,
serving-store selection, primitive source-of-truth move, legacy retirement,
`stateContract` change, retention/prune, migration, performance claim,
deployment, live action, or issue closure.

### Slice W5 — the focused delayed-or-missing-ACK query proof

Checklist item 489 asks for focused proof that a query cannot resolve
successfully across a delayed or missing earlier durable ACK. W1 through W4 did
not provide it, and it is worth being precise about why, because the gap was
easy to mistake for covered ground.

W1 already proves a query goes `unavailable` once the barrier *cannot be
proved* — but it reaches that state by killing the worker. A crash is a
different mechanism from an acknowledgment that is merely outstanding. The
failure 489 guards against is not a crash: it is a query answering from state it
was not yet entitled to see, while an earlier committed write is still in
flight. A lane could pass every W1 test and still do that, because nothing there
holds an ACK back and then releases it.

This slice adds one test file and changes no source. It asserts three shapes of
"the ACK has not crossed yet". A **delayed** ACK: while an earlier ticket is
dispatched and unanswered, the later query is not dispatched at all and does not
settle; when the ACK crosses, the query reaches the wire strictly after it, and
that ordering is asserted on the wire rather than inferred from a result that
happened to look right. A **missing** ACK with no failure signal: the query
never resolves successfully, and when the lane is finally torn down it resolves
`unavailable` rather than succeeding late. A **missing** ACK declared by
timeout: the earlier ticket becomes ambiguous and the query is then
operation-preserving `unavailable` with `achievedConsistency: null`. A fourth
case drives a real worker, because a scripted channel could in principle satisfy
all three while a genuine durable commit still raced.

**The assertions were checked for teeth.** A test that cannot fail proves
nothing, and this file's central claim — that a query stays behind an
unacknowledged write — is exactly the kind that passes for the wrong reason if
the queue happens to be empty. The lane was temporarily mutated to let a queued
query jump the FIFO, and all five tests failed; the mutation was reverted and
the file restored byte-identical before anything was committed. That is the same
discipline the Phase 2 adversarial controls exist to enforce, applied to a
proof this lane wrote for itself.

W5 checks no box. 489 additionally requires what 488 requires, and whether the
seven worker-mode harnesses satisfy W0's wording — "every applicable V1
deterministic conformance/failure suite" — has not been recorded. That judgment
would also have to say what "applicable" excludes and why, and it should not be
taken by a slice that benefits from the answer. It adds no broker runtime or
HTTP import, existing persistence-worker change, configuration flag, default,
serving-store selection, primitive source-of-truth move, legacy retirement,
`stateContract` change, retention/prune, migration, performance claim,
deployment, live action, or issue closure.

### Decision W6 — what "applicable" means for 488, and why neither box is checked

W5 closed by naming the judgment it could not take: whether the seven
worker-mode harnesses satisfy W0's wording, "every applicable V1 deterministic
conformance/failure suite", and what "applicable" excludes and why. This slice
takes that judgment. It was taken by a reviewer who wrote none of W1 through
W5, which is the condition W5 attached to it. It changes no source and adds no
test.

**"Applicable" is decided by mode-dependence, not by suite lineage.** A V1
deterministic conformance/failure suite is applicable to 488 when its claim
could come out differently once the adapter is owned by a worker thread behind
the bounded FIFO lane. That is the only reading under which running a suite
through worker mode proves something, and it is the reading W0 already implies
when it refuses protocol shape, queue FIFO tests, and inline evidence as
grounds. Four categories therefore fall outside it. Static assertions over
source text or a prototype — the descriptor shape and collapse arithmetic each
target declares, and the "keeps every conformance seam off the adapter's public
surface" test present in all seven inline targets — cannot change with
execution mode, because no database is opened. In-address-space artifacts are
excluded for the opposite reason: a prepared-SQL log and a fault armed at a
statement position are observable only from the thread holding the connection,
and exporting them across the lane would widen the closed control protocol that
W0 exists to keep narrow. Pre-open lifecycle windows are excluded because they
are structurally unobservable: the worker runtime opens the adapter during
bootstrap, so there is no interval in which the lane can present an unopened
adapter. And suites driven by stubs or golden fixtures rather than a real
database are excluded by W0's own sentence.

**The four suites that construct the adapter but were never ported.** Measured
at this commit, eleven test files construct `SharedStateSqliteAdapterV1`; seven
have worker-mode counterparts and four do not, totalling 3,976 lines and 74
tests. Each is answered separately, because the aggregate number is misleading.

`shared-state-sqlite-query-surface-v1.test.ts` (239 lines, 7 tests) is **not
applicable**. Six of its seven tests drive hand-written stub dispatchers and a
golden JSON fixture and open no database at all; the seventh, "maps a real
not-ready SQLite dispatcher to closed unavailable" at line 222, is a pre-open
case. Running shape assertions through a worker would be inline evidence
wearing a worker costume.

`shared-state-sqlite-adapter-v1.test.ts` (2,804 lines, 55 tests) is **not
applicable as a suite**, and this is the answer most at risk of being wrong, so
it is given in parts. It is the inline unit suite of the adapter, not a Phase
2.x conformance harness. Its genuinely mode-dependent claims — exclusive
ownership, monotonic lifecycle epoch, fails-closed on lost ownership, expiry
boundaries, lease fencing, idempotent replay — are already proved through the
lane by the worker lease, expiry, idempotency, restart-continuity, and
partition targets, so porting them re-proves settled ground. The residue is
what cannot be ported: forty-one of its tests assert or mutate through the raw
`DatabaseSync` the fixture hands them, against roughly ten tables, and the
conformance control channel is a closed enum of harness-shaped reads with no
generic SELECT, deliberately. The statement-ordering proof at line 2394 works
by proxying `prepare` and comparing indices in a captured SQL log. The
schema-refusal test at line 784 needs an adapter opened against a missing or
corrupted schema, which both worker entry points make unreachable by applying
the schema and throwing before the adapter exists. Porting this suite means
inventing about a dozen new control names, which is the protocol widening W0
forbids, in exchange for claims already held elsewhere.

`shared-state-sqlite-query-graph-v1.test.ts` (536 lines, 6 tests) and
`shared-state-sqlite-query-outbox-v1.test.ts` (397 lines, 6 tests) are
**partially applicable, and this is a real gap.** Their pre-open tests, at
graph line 519 and outbox line 378, are excluded as unobservable. Their cursor
and ordering tests are portable but duplicative, since the query families
already run end-to-end through a real thread in the W1 lane suite. But four
tests are neither: "returns closed unavailable for a busy writer and lost
ownership" at graph line 456 and outbox line 324, and the malformed-durable-
state tests at graph line 489 and outbox line 355. These are read-path
fails-closed proofs, they depend on who owns the connection, and nothing in
worker mode covers them. The ACK barrier added by W5 proves the barrier holds;
it does not prove a read fails closed against a rival writer's lock, a
withdrawn ownership row, or a corrupted durable row. Checklist item 489 is
explicitly a read-path item, so this gap bears on 489 directly and not only
through 488.

**The seven ported harnesses are not a one-to-one port, and that is where the
larger gap is.** The four unported suites are the visible number; they are
mostly not applicable. The harnesses recorded as done are the opposite. Across
the seven pairs the inline targets hold 57 tests and the worker targets hold
21, and by assertion content rather than test name roughly 14 are genuinely
re-proved. The adversarial layer is complete and should be said so plainly:
every fails-closed control name and expected error code appears verbatim in the
corresponding worker target, in all seven pairs, with no omission. The harness
runs are likewise ported. What is missing divides in two. Some of it is
correctly excluded under the definition above — the static descriptor and
seam-surface tests, and the statement-position tests — but only two worker
headers, claim-graph at line 28 and idempotency at line 25, actually say so.
The lease, outbox, and restart-continuity headers drop the same statement-
position assertion silently, and their "declares the control inventory and
fault mapping" tests assert the static plan rather than an observed firing
position, which is a resemblance of name and not of content. Those three
exclusions are correct but unrecorded, and an unrecorded exclusion is
indistinguishable from an oversight by anyone reading later.

The rest is not correctly excluded. Worker targets hold no raw handle by
design, so no worker test can assert what reached disk. That removes the lease
write-effect test at line 810, the expiry retention and lease-fence provenance
tests at lines 643 and 720, the partition stale-answer test at line 1134, and
the outbox sequence-provenance test at line 604. It also removes three
partition proofs about the adapter's real state under stress: a genuine
`SQLITE_BUSY` producing `lock_timeout` at line 996, a level-triggered arm that
keeps firing and is restored by disarming at line 1054, and a genuinely failed
lifecycle before a not-ready report at line 1088. The worker suite substitutes
adversarial controls that catch a lying target, which proves the harness is
honest rather than that the adapter behaved. These claims are mode-dependent by
the definition this decision adopts, so their absence is a coverage gap and not
an exclusion. It is a plumbing debt, not a design error: the no-bypass rule is
right, and the missing piece is a small set of closed read controls that would
let a worker target observe durable state without opening a second connection.

**On the two exclusions W2d and W2f recorded.** Both are upheld. Statement
ordering is a property of the adapter's SQL order rather than of the lane, and
the inline target asserts it against its own `preparedSql` log; seam firing
position is the same claim. Neither becomes a different fact when the adapter
sits behind a worker. The correction owed is documentary, not substantive: the
same exclusion applies to three further pairs whose headers do not mention it.

**On the W2e divergence between inline and worker mode.** W2e kept W0's close
rule rather than relaxing it to match inline, so in the scenario where `drain`
legitimately refuses, the inline target closes anyway and releases ownership
while the worker target tears down without claiming ownership was released and
reopens with the same owner token. The exit gate in the plan reads "both inline
and worker-writer SQLite modes pass the same V1 suite". This is **not a
violation of that gate.** Both modes pass the same suite; W0 is the later and
more specific decision, and it deliberately forbids in worker mode what inline
permits. The gate is nonetheless weaker than it looks, because "passes the same
suite" was serving as a proxy for "behaves the same way", and here the proxy
leaks: one scenario is passed by two different routes. The honest repair is to
say so in the plan rather than to reinterpret the gate. This decision does not
make that edit, because the plan is the artifact a later slice must change
alongside checking the box; it is carried below as owed work, namely that W0's
close rule takes precedence and that a shared suite does not imply shared
paths.

**Neither 488 nor 489 is checked.** 488 fails on the read-path fails-closed
gap and on the write-effect and adapter-state assertions dropped from the seven
ported harnesses. 489 says "additionally", so it requires what 488 requires;
its own focused proof is in hand and was checked for teeth, but it cannot stand
on a foundation that is not yet there. The order matters and must not be
inverted. It is worth recording that the reason differs from the one the
handoff expected: the 3,976 unported lines are largely not applicable, and the
exposure is inside the work already recorded as complete.

**What a later slice must do before 488 can be checked.** Add closed read
controls sufficient for a worker target to observe durable state without a
second connection — lease row effects, expiry retention across the exclusive
boundary, ownership epoch against the lease fence, and partition checkpoint and
high-water state — and port the five write-effect assertions onto them. Port
the three partition proofs about real adapter state under stress, reusing the
rival-inside-the-worker machinery W3 established rather than adding a new
bypass. Port the four read-path fails-closed cases from the graph and outbox
query suites, which is the highest priority of the three because 489 depends on
it directly. Record the statement-position exclusion in the lease, outbox, and
restart-continuity worker headers. Amend the plan's exit gate to name W0's
close rule as a permitted divergence. None of that requires a new adapter, a
runtime change, or a wider lane protocol.

W6 checks no box and is a documentation decision only. It adds no broker
runtime or HTTP import, existing persistence-worker change, configuration flag,
default, serving-store selection, primitive source-of-truth move, legacy
retirement, `stateContract` change, retention/prune, migration, performance
claim, deployment, live action, or issue closure. Issue #1504 remains OPEN.

### Slice W7 — the read-path fails-closed ports, and a false pass they nearly hid

W6 listed five owed items and ranked the read-path fails-closed ports first,
because checklist item 489 is explicitly a read-path item. This slice takes that
one. It ports the four cases named there — a rival writer's lock and a withdrawn
ownership row, each for both closed query families, plus malformed durable state
for each — into worker mode. Six tests, because the two "busy writer and lost
ownership" inline tests each carry two independent arms that are cleaner apart
than together.

**Decision W3's rival is reused rather than rebuilt.** The lock the inline tests
take with a second main-thread `DatabaseSync` is already available inside the
conformance worker as the Phase 2.5 rival, taken and released through
`partitionEstablish` and `partitionHeal`. The ownership withdrawal is the same
control's `unavailable` point, which performs exactly the `UPDATE
shared_state_ownership` the inline tests write by hand. Those four cases needed
no new control at all.

**One control was added.** Nothing in the closed set corrupts a committed row in
place: `expiryViolation` and `leaseClearViolation` only ever delete, and proving
a read refuses a *malformed* row needs the row to still be there and be wrong.
`readPathCorruption` names a closed corruption and the row's own identity
digest, and carries no table, column, literal or predicate — those are fixed by
the corruption member, so the reviewable inventory stays the enum rather than
the call site. Nothing reads the row back afterwards; the assertion is the
query's refusal, and a confirming SELECT would be the generic read W0 keeps out
of this channel. The lane protocol is unchanged, and the target opens no
`DatabaseSync`.

**The part worth recording is what the first version of this got wrong.** The
lane answers a ticket it cannot admit with its own operation-preserving
`unavailable` envelope, carrying `achievedConsistency: null` and reason
`authority_unavailable` — the same shape the adapter returns when it refuses
malformed durable state. So a test asserting only status, consistency and reason
code passes whether or not the query ever reached the adapter. That much was
anticipated, and the guard chosen for it was to assert the adapter was still
`ready` afterwards.

That guard does not work, and it was measured rather than argued. Saturating a
lane produces `{status: "unavailable", achievedConsistency: null, reasonCode:
"authority_unavailable"}` with `adapterLifecycle` reporting `ready`, because a
refusal that never reaches the adapter cannot change its lifecycle either. The
two cases are indistinguishable on every field the first version asserted. A
suite that looked like it was proving the adapter fails closed would have been
proving only that some component somewhere said `unavailable`.

The discriminator is admission: a lane refusal increments `refusedAdmissions`
and never dispatches, while an answer from the adapter is an admitted ticket. So
every case asserts `refusedAdmissions` stayed at zero across the query. The
lifecycle assertion is kept beside it for the narrower claim it does support —
that the adapter declined without failing itself, which is what separates a busy
file from a lost authority.

**The assertions were checked for teeth**, in three passes. Removing the
corruption injection failed exactly the two malformed-state tests and nothing
else. Removing the partition establishment failed exactly the four lock and
ownership tests. Forcing the lane to refuse admission — capacity lowered and
every injection removed — failed all six, which is the pass that demonstrates
the new guard is load-bearing rather than decorative; under the first version's
lifecycle-only guard those same six would have passed. Each mutation was
reverted and the file restored byte-identical before anything was committed.

W7 checks no box. It closes one of W6's five owed items; the write-effect ports,
the three partition adapter-state ports, the two documentary corrections and the
plan's exit-gate amendment are still outstanding, and whether the set then
satisfies W0's wording remains the separate judgment W6 described. It adds no
broker runtime or HTTP import, existing persistence-worker change, configuration
flag, default, serving-store selection, primitive source-of-truth move, legacy
retirement, `stateContract` change, retention/prune, migration, performance
claim, deployment, live action, or issue closure. Issue #1504 remains OPEN.

### Slice W8 — the documentary corrections W6 owed, and six headers that had gone stale

W6 owed two documentary items: recording the statement-position exclusion in the
worker headers that dropped it silently, and amending the plan's exit gate to
name W0's close rule as a permitted divergence. This slice takes both, and fixes
a third defect found while doing so. It changes no source and adds no test.

**The statement-position exclusion is now recorded where it applies.** W6 found
five worker targets that drop an inline assertion about where in the statement
stream a fault or seam fires, and only two headers — claim-graph and
idempotency — said so. The exclusion itself is upheld: the inline target asserts
it against its own `preparedSql` log, which is an in-address-space artifact, and
what it pins is a property of the adapter's SQL order rather than of the lane.
The lease, outbox and restart-continuity headers now say the same thing about
their own assertion. An unrecorded exclusion is indistinguishable from an
oversight by anyone reading later, which is the whole reason W6 called it owed.

**Six of the seven headers were asserting something that had stopped being
true.** Each was written mid-sequence and counted the harnesses not yet ported —
"Phase 2.5 still runs inline only" in lease, "Four harnesses still run inline
only" in outbox, and similar counts in claim-graph, idempotency, restart-
continuity and expiry. All seven have run in worker mode since W4, so every one
of those sentences was false, and each was false in the direction that
overstates how much is left rather than how much is done. Only the partition
header, written last, was accurate. They now say what actually remains inline:
the write-effect assertions no worker target can make while holding no raw
handle, and the Phase 2.5 proofs about the adapter's real state under stress.

This was not on W6's list. It was found while editing the three headers W6 did
name, and it is worth recording that the defect class is the same one W6
described — a file stating the state of the world at the moment it was written
and never revisited. The counts are removed rather than corrected, because a
count is exactly the kind of claim that goes stale silently; the replacement
names the categories instead.

**The exit gate now says what it does and does not prove.** The plan reads "both
inline and worker-writer SQLite modes pass the same V1 suite", and W6 found that
wording was serving as a proxy for "behaves the same way" while one scenario is
passed by two different routes: inline closes a failed adapter and releases
ownership even when `drain` refused, and W0 permits releasing ownership only
after a successful drain, so worker mode tears down without claiming the release
and reopens with the same owner token. W6 judged that a permitted divergence
rather than a gate violation and this slice does not reopen that judgment. What
it adds is the sentence the gate was missing: passing the same suite does not
mean taking the same path, and the gate is not evidence the modes behave
identically — only that neither fails.

W8 checks no box. Two of W6's five owed items remain: the write-effect ports and
the Phase 2.5 adapter-state ports, both of which need new closed read controls
rather than documentation. It adds no broker runtime or HTTP import, existing
persistence-worker change, configuration flag, default, serving-store selection,
primitive source-of-truth move, legacy retirement, `stateContract` change,
retention/prune, migration, performance claim, deployment, live action, or issue
closure. Issue #1504 remains OPEN.
