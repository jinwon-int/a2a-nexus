# Checklist: Shared-State and HA Contract

> **Status:** closeout checklist. Checked items include the completed
> documentation packet and narrowly proven Phase 1 contract/parser and
> keyspace/digest/time-evaluator/idempotency-registry/outbox-registry and
> observability-catalog/parser/projector work, plus the bounded Phase 2.1
> lease/claim, Phase 2.2 `executeIdempotent`, and Phase 2.3 outbox-ordering
> and Phase 2.4 restart-continuity backend-neutral conformance harnesses and
> their clearly labeled test-only deterministic reference-model proofs.
> Runtime/query integration, SQLite/shared adapter conformance,
> retention/prune execution, migration, and operations remain open.
> Refs #1504.

## A. Spec packet

- [x] `spec.md` defines normative language and documentation-only scope.
- [x] `clarify.md` resolves topology, time, consistency, expiry, privacy, and
  approval questions.
- [x] `analyze.md` reconciles the contract with pinned current source.
- [x] `plan.md` defines staged source, migration, cutover, and rollback gates.
- [x] `tasks.md` contains deterministic implementation/test work.
- [x] This checklist separates completed docs from future work.
- [ ] Required spec-first packet approval is recorded.

## B. Deployment truth

- [x] `single-process` is defined as supported alpha.
- [x] `single-writer-durable` is defined as one process/logical SQLite writer,
  with current volatile replay/rate caveat.
- [x] `multi-process-unsupported` is non-serving.
- [x] `shared-state-ha` is future/unavailable.
- [x] SQLite/WAL/worker thread is not described as clustering.
- [x] No future backend is claimed, selected, or provisioned.

## C. Primitive contract coverage

For every row below, source of truth, atomicity, consistency, TTL/expiry,
restart, partition, fail-closed, observability, and adapter lifecycle are
specified in `spec.md`.

- [x] Nonce/replay.
- [x] Rate limit.
- [x] Lease/task claim with fencing.
- [x] Idempotency.
- [x] Terminal-outbox ordering/ACK.
- [x] Claim-graph source/read-model/checkpoint/rollback.

## D. Adapter contract

- [x] Contract identifier is `a2a.shared-state.storage/v1`.
- [x] Metadata, capability, lifecycle, transaction, query, health, drain, and
  close surfaces are defined.
- [x] Atomicity, per-key linearizability, expiry, fencing, idempotency,
  outbox, and projection capabilities are mandatory.
- [x] A later SQLite single-writer and later shared implementation can satisfy
  the same observable semantics.
- [x] Current generic SQLite store is not labeled conforming.
- [x] The first bounded TypeScript slice provides closed metadata,
  capabilities, lifecycle, expected-open, health/readiness, declaration, and
  section 6.1 transaction envelope schemas with stable parser errors.
- [x] Keyspace V1 pins NFC/UTF-8, typed length framing, uint128 encoding,
  namespace/component bounds, 22 purpose domains, purpose-bound digest tokens,
  and stable canonicalization errors for every digest-bearing section 6.1
  field.
- [x] Time V1 pins trusted profile-bound clock observations, canonical
  signed-int64-range Unix-millisecond strings, durable non-decreasing floors,
  declared skew tolerance, safe clamping/fail-closed outcomes, and exact
  replay/lease/idempotency/rate boundaries without adding a clock or runtime
  callsite.
- [x] Idempotency V1 inventories six current durable-but-partial authorities,
  registers six exact planned namespace/retention pairs with closed
  effect/horizon/dependency/prune/migration rules, and binds only the Section
  6.1 `executeIdempotent` command parser without claiming runtime integration.
- [x] Outbox V1 inventories the one current durable-but-partial terminal
  outbox authority and all three current producer purposes, registers their
  exact planned namespace/purpose, typed stream key, per-key order,
  adapter-owned sequence, event/idempotency, receipt/ACK, retention/prune, and
  migration rules, and binds only the three Section 6.1 outbox command parsers
  without claiming runtime integration.
- [x] Observability V1 inventories every pinned public readiness, public
  health aggregate, and separately authorized operator aggregate requirement;
  pins closed visibility/availability/reason/band/count vocabularies and
  whole-group aggregation floors; and binds only to the existing pure health
  declaration parser without adding a route or runtime collector.
- [ ] Machine-readable V1 types/schemas implemented.
- [ ] SQLite V1 adapter implemented.
- [ ] Shared V1 adapter implemented.

## E. Startup/readiness/health

- [x] Exact configured/effective grade behavior is defined.
- [x] Declaration plus fenced ownership detects unsupported topology.
- [x] Startup fails before traffic where possible.
- [x] Lost ownership makes all non-liveness routes non-serving.
- [x] `/livez`, planned `/readyz`, and `/health` meanings are separated.
- [x] Replay/rate reset risk and continuity signals are specified.
- [x] Secret/identity-bearing health data is forbidden, including digests.
- [ ] Startup grade/ownership code implemented.
- [ ] `/readyz` and non-serving middleware implemented.
- [ ] Runtime health signal implemented and leak-tested.

## F. Deterministic local tests

- [x] Claim/lease concurrency and stale-fence plan exists.
- [x] Idempotency same/different fingerprint and ambiguous-commit plan exists.
- [x] Per-stream outbox order/restart/ACK plan exists.
- [x] Restart and backward-clock plan exists.
- [x] Partition/unavailable/lost-fence injection plan exists.
- [x] Exact expiry-boundary plan exists.
- [x] Claim-graph query/incomplete/false-merge rollback plan exists.
- [x] Migration/cutover/rollback rehearsal plan exists.
- [x] Bounded local performance-characterization plan exists.
- [x] Narrow parser fixtures exhaust every section 6.1 transaction union and
  reject unknown versions/fields, unsafe capabilities, caller clocks, backend
  commands, sensitive connection fields, and identity-bearing health fields.
- [x] Public synthetic golden fixtures independently recompute every registered
  digest domain and reject delimiter ambiguity, wrong domains/namespaces,
  component reordering, Unicode ambiguity, bad bounds/types/bytes, and unsafe
  integers.
- [x] Public synthetic time fixtures and pure table tests cover floor and skew
  boundaries, restart floor preservation, logical expiry/rate boundaries,
  cleanup independence, large/overflow values, both clock profiles, every
  stable time reason/error code, and section 6.1 caller-clock rejection.
- [x] Public synthetic idempotency registry fixtures and deterministic parser
  tests cover source-evidence completeness, unique exact pairs, all entries,
  unknown/mismatched/non-canonical/extended inputs, non-expiring safety,
  time-v1-only future expiry, generic unrelated namespaces, and every new
  stable error/reason code.
- [x] Public synthetic outbox registry fixtures and deterministic parser tests
  cover current-source inventory completeness, unique exact registrations,
  every valid purpose, exact component framing/order, case/Unicode/wildcard/
  unknown/extra rejection, same-stream order, cross-stream isolation, no
  global-order claim, original idempotent event/sequence binding,
  provider-acceptance/non-ACK separation, retention/prune safety, the three
  Section 6.1 parser integrations, and every new stable error/reason code.
- [x] Public synthetic observability fixtures and recursive negative leak
  corpus cover all three projection boundaries, every stable code/path,
  unknown version/field/type/range/enum rejection, closed bands/reasons,
  absent/unavailable shapes, public/operator floor separation, whole-group
  suppression, hashed/pseudonymous identity rejection, Unicode/case and
  prototype-key rejection, and sentinel absence from successful serialization.
- [x] Backend-neutral lease/claim conformance harness interface implemented
  with an injected fake clock, seeded contender order, explicit promise
  barrier, bounded operation count, and closed public-safe reports/errors.
- [x] Test-only deterministic reference-model claim tests implement and pass
  the exact 32-way claim race, monotonic fencing, exact-expiry reclaim,
  unchanged-state stale-fence rejections, four all-or-none transaction fault
  points, close/reopen snapshot preservation, and simultaneous singleton
  ownership rejection.
- [x] Backend-neutral `executeIdempotent` conformance harness interface
  implemented with the existing storage V1 parser, closed idempotency
  registry, stable decision/reason vocabulary, digest keyspace, injected fake
  clock, seeded schedules, explicit promise barriers, eight isolated
  factory-created targets, a 96-operation ceiling/78-operation exact count,
  and strict public-safe aggregate reports, snapshots, faults, and errors.
- [x] Test-only deterministic idempotency reference-model tests implement and
  pass the exact 64-way same-fingerprint race, either bounded winner rank for
  the two-way different-fingerprint conflict, exact post-commit ambiguous
  recovery, four exact empty-baseline pre-commit rollbacks followed by one
  clean execution, and close/reopen outcome/snapshot continuity under the
  registered non-expiring policy without retention/prune execution.
- [x] Backend-neutral outbox-ordering conformance harness interface
  implemented with the existing storage V1 parser and command/results, closed
  registry/policy/retry-binding/ordering evaluators, stable decisions and
  rejection vocabulary, digest keyspace, seeded eight-producer schedule,
  explicit promise barrier, seven isolated factory-created targets, a
  40-operation ceiling/34-operation exact count, and strict non-reflecting
  public-safe reports, snapshots, cursors, controls, faults, and errors.
- [x] Adjacent test-only deterministic outbox reference-model tests implement
  and pass exactly two registered stream keys/four producers each with
  per-stream unique increasing sequences in adapter serialization/sequence
  order, seeded producer attribution with no caller-fairness assertion, and
  no global-order assertion;
  original-binding append retry without duplicate effects; the two exact
  empty-baseline append transaction faults; confirmed-but-unacknowledged
  ACK-before-commit recovery through `acknowledged` and
  `already_acknowledged`; close/reopen start/intermediate/end cursor
  reconciliation with per-stream order, duplicate, replay, and state
  preservation checks; and provider-accepted pending/non-ACK parser-policy
  rejection.
- [x] Backend-neutral restart-continuity conformance harness interface
  implemented with the existing storage V1 command/result/lifecycle parsers,
  keyspace digests, closed idempotency/outbox registries, time V1 evaluator,
  stable decision/rejection/unavailable vocabulary, one injected exact-integer
  fake clock, deterministic serial seeded crash schedule, six isolated
  factory-created targets, a 64-command ceiling/45-command exact count, and
  strict aggregate-only non-reflecting reports, snapshots, controls, and
  errors.
- [x] Adjacent test-only deterministic restart reference-model tests implement
  and pass the exact pre-boundary continuity baseline for replay, rate, lease
  authority/fence, idempotency domain/outbox effect, two-stream outbox
  sequence/receipt/ACK/cursor reconciliation, and graph source/checkpoint;
  exact before/after command and ACK crash recovery through existing
  unavailable/ambiguous outcomes; exact one-millisecond-beyond-tolerance
  unsafe-clock fail-closed/recovery behavior; and nondecreasing fence, lease
  resource version, every retained stream high-water, graph source sequence,
  and projection checkpoint.
- [x] Phase 2.4 test-only snapshot, crash, cursor, reconciliation, and fake
  clock seams are explicitly conformance controls, not competing storage,
  clock, health, readiness, query, adapter, or runtime APIs; the reference
  model is in-memory, non-production, non-SQLite, non-shared, non-conforming,
  detached, and makes no durability claim for close/reopen state retention.
- [x] Backend-neutral expiry-boundary conformance harness interface
  implemented with the existing storage V1 command/result/lifecycle parsers,
  keyspace digests, closed idempotency/outbox registrations, the existing time
  V1 logical-boundary and expiry-derivation evaluators, stable
  decision/rejection/unavailable vocabulary, one injected exact-integer fake
  clock, a seeded deterministic fixture order, seven isolated
  factory-created targets, a 64-command ceiling/44-command exact count, and
  strict aggregate-only non-reflecting reports, snapshots, controls, and
  errors.
- [x] Adjacent test-only deterministic expiry reference-model tests implement
  and pass the exact `expiry-1`/`expiry`/`expiry+1` matrix over all four
  closed boundary kinds with equality expired/excluded and the
  before-epoch-threshold counted case; refused early eviction of a logically
  active record and unchanged retained counts across the boundary; sheddable
  new work under critical capacity pressure with no permissive eviction of an
  unexpired replay or idempotency safety record; expiry alone leaving
  ownership untransferred followed by one atomic reclaim that strictly
  advances the fence and rejects the stale fence; and no implicit TTL for
  unacknowledged outbox rows or claim provenance across a bounded maximum
  advance, including parser rejection of caller-supplied retention fields.
- [x] Phase 2.6 test-only snapshot, physical-cleanup, and capacity-pressure
  seams are explicitly conformance controls, not competing storage, clock,
  health, readiness, query, adapter, or runtime APIs; the reference model is
  in-memory, non-production, non-SQLite, non-shared, non-conforming, detached,
  retains physically expired rows only as a conformance control, and executes
  no retention or prune.
- [x] Backend-neutral claim-graph projection and rollback conformance harness
  interface implemented with the existing storage V1 command/result/lifecycle
  parsers, keyspace digests, closed `graphNodeTypes` and graph-completeness
  vocabulary, stable decision/rejection/unavailable vocabulary, a seeded
  deterministic source order, no clock, three isolated factory-created
  targets, a 48-command ceiling/31-command exact count, and strict
  aggregate-only non-reflecting reports, snapshots, controls, and errors.
- [x] Adjacent test-only deterministic claim-graph reference-model tests
  implement and pass typed provenance-bearing source appends across all six
  closed node types with strictly increasing sequences; one atomic projection
  batch answered as `path_found` from graph and source references only;
  projection paused behind the source high-water reported as
  `projection_incomplete` with exact lag and unchanged checkpoint, plus a
  `source_range_incomplete` rejection for a batch reaching past the durable
  high-water; a fault between node/edge writes and the checkpoint leaving the
  checkpoint and graph state exactly unchanged and reporting
  `projection_unavailable`, followed by one clean retry; an injected false
  merge reversed by its recorded inverse batch with the prior graph restored
  and immutable source facts intact; and idempotent reapplication of the same
  batch and the same rollback.
- [x] Phase 2.7 negative evidence is withheld unless the checkpoint is
  complete, matching `negativeEvidenceRequires=complete-checkpoint`; the four
  spec section 5.6 results are declared as harness-owned vocabulary because V1
  registers no query operation, and the evidence-path seam is a bounded
  test-only conformance control rather than a storage query, graph service, or
  runtime API.
- [x] Backend-neutral partition and unavailable-injection conformance harness
  interface implemented with the existing storage V1 command/result/lifecycle
  parsers, keyspace digests, the closed unavailable/lifecycle/readiness reason
  vocabulary, a seeded deterministic fault order, no clock, five isolated
  factory-created targets, a 64-command ceiling/18-command exact count, and
  strict aggregate-only non-reflecting reports, snapshots, controls, and
  errors.
- [x] Adjacent test-only deterministic partition reference-model tests
  implement and pass all five declared fault points mapped to their exact
  closed unavailable reasons with no empty or permissive local decision and no
  state mutation; protected replay and rate requests failing closed as
  `authority_unavailable` and `lock_timeout`; claims, renewals, fenced
  mutations, and idempotent mutations refusing to apply while the authority is
  unavailable followed by one clean retry applying once; an outbox producer
  transaction failing atomically with consumer replay preserved, ACK refused
  while partitioned, and nothing pruned; and a partitioned read served as an
  explicitly stale answer carrying checkpoint and lag.
- [x] Phase 2.5 readiness is proved at the adapter-lifecycle layer only, and
  the two-layer vocabulary claim is checked rather than asserted: every
  lifecycle fault reason has an exact readiness counterpart (eight codes) and
  the only lifecycle-only codes are normal transitions. `/readyz`, the
  non-serving middleware, and route status remain Phase 4 and are not proved
  here. `lock_timeout` and delayed-read had no prior coverage in the
  repository and are exercised for the first time.
- [ ] Claim tests pass against a SQLite or shared adapter.
- [ ] Idempotency tests pass against a SQLite or shared adapter.
- [ ] Idempotency retention/prune execution is implemented and proven.
- [ ] Outbox tests pass against a SQLite or shared adapter.
- [ ] Outbox runtime/query reconciliation and retention/prune execution are
  implemented and proven.
- [ ] Restart-continuity tests repeat and pass through a SQLite/shared adapter
  with actual durability and adapter clock-floor persistence.
- [ ] Partition/unavailable tests repeat and pass through a SQLite/shared
  adapter against a real authority, and the Phase 4 route-level readiness
  assertion is implemented/passing.
- [ ] Exact expiry-boundary tests repeat and pass through a SQLite/shared
  adapter, including authorized retention/prune execution at and after the
  logical boundary.
- [ ] Claim-graph/rollback tests repeat and pass through a SQLite/shared
  adapter, including a real query surface rather than a test-only
  evidence-path control.
- [ ] Performance thresholds measured/approved.

## G. Migration/cutover

- [x] Preconditions and canonical-authority boundary are explicit.
- [x] Shadow/dual-read or deterministic equivalent cannot drive live
  decisions.
- [x] Cross-backend shadow uses a durable journal/outbox, not best-effort
  dual writes.
- [x] SQLite and future HA cutover gates are explicit.
- [x] Unexportable volatile security state requires a non-serving safety
  window.
- [x] Exact separate live actions are enumerated.
- [ ] Local/offline migration rehearsal completed.
- [ ] Production backup/read authorized.
- [ ] Production migration/shadow authorized.
- [ ] Cutover gates satisfied and authorized.
- [ ] Any migration or cutover executed.

## H. Rollback

- [x] Rollback triggers are explicit.
- [x] Security windows, idempotency outcomes, fences, outbox order/ACK, and
  graph source/checkpoint invariants are preserved.
- [x] Unrepresentable rollback fails closed instead of losing data.
- [x] Rollback sequence keeps one authority and restores traffic last.
- [ ] Local failure-injection rollback rehearsal completed.
- [ ] Production rollback authorized or executed.

## I. Public truth and safety

- [x] `docs/known-limitations.md` links the contract while retaining current
  limitations.
- [x] `packages/broker/docs/persistence-durability.md` links the contract and
  states that SQLite is not multi-process/HA.
- [x] References use `Refs #1504`, not an issue-closing keyword.
- [x] No production migration, backend provision, cutover, deploy/restart,
  replay/ACK/prune, provider send, GitHub mutation, release/tag, force push,
  merge, or issue close is authorized.
- [x] Documentation/link/public-readiness checks recorded after edits.
- [x] `npm run scan:external-secrets` recorded after edits.
- [x] `git diff --check` recorded after edits.
- [x] Pre-PR OpenClaw runtime/bootstrap path guard is clean.

## J. Overall status

- [x] Documentation/specification drafted.
- [ ] Spec-first packet approved.
- [ ] Runtime implementation complete.
- [ ] Adapter conformance tests complete.
- [ ] Migration complete.
- [ ] Operational rollout complete.
- [ ] `shared-state-ha` supported.
