# Tasks: Shared-State and HA Contract

> **Status:** implementation backlog. Checked items include the completed
> documentation packet and the completed bounded Phase 1 contract/parser and
> keyspace/digest/time-evaluator/idempotency-registry/outbox-registry and
> observability-catalog/parser/projector slices, plus the first bounded Phase
> 2.1 lease/claim, Phase 2.2 `executeIdempotent`, and Phase 2.3 outbox-ordering
> backend-neutral conformance harnesses exercised against clearly labeled
> test-only deterministic reference models. SQLite/shared adapter
> implementations and their conformance, retention/prune execution, runtime
> health/endpoint and query integration, migration, and operational rollout
> remain unchecked.
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
- [ ] Obtain required approval for the packet.

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
where the scenario has time semantics; the Phase 2.3 slice has none.

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
  in deterministic append order within each exact stream, use the existing
  same/different-stream ordering evaluator decisions, and make no global
  cross-stream ordering assertion.
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

- [ ] Persist unexpired replay nonce, in-window rate cost, active claim/fence,
  idempotency outcome, outbox/cursor/ACK, and graph checkpoint.
- [ ] Close/reopen at deterministic clock instants and assert all values and
  decisions continue.
- [ ] Simulate crash before and after commit/ACK; assert recovery has one
  known outcome.
- [ ] Move the wall clock backward beyond tolerance and assert readiness
  failure without early expiry.
- [ ] Assert no fencing token, stream sequence, or projection checkpoint
  decreases after restart.

### 2.5 Partition/unavailable injection

- [ ] Wrap the adapter with deterministic unavailable, timeout,
  ambiguous-commit, lost-fence, and delayed-read fault points.
- [ ] Assert replay/rate protected requests return unavailable, never an empty
  local decision.
- [ ] Assert claims/renewals/completions and idempotent mutations do not apply
  while authority is unavailable.
- [ ] Assert outbox producer transaction fails atomically; consumer may replay
  but cannot ACK/prune while partitioned.
- [ ] Assert graph queries distinguish stale/incomplete/unavailable from
  `no_evidence_path`.
- [ ] Assert `/readyz` becomes false and non-liveness routes stop serving
  while `/livez` remains liveness-only.

### 2.6 Expiry boundaries

- [ ] For replay, rate cost, lease, and allowed idempotency-retention fixtures,
  test `expiry-1`, `expiry`, and `expiry+1` with the fake clock.
- [ ] Assert physical cleanup delay never changes logical decisions.
- [ ] Assert capacity pressure never evicts unexpired replay/idempotency
  safety records permissively.
- [ ] Assert lease expiry requires an atomic ownership transition and advances
  the fence.
- [ ] Assert unacknowledged outbox and claim provenance have no implicit TTL.

### 2.7 Claim-graph projection and rollback

- [ ] Append typed `Entity`, `Claim`, `Source`, `Artifact`, `AgentRun`, and
  `Evaluation` source fixtures with provenance.
- [ ] Project one batch atomically and answer a cross-task evidence-path query
  using graph/source references only.
- [ ] Pause projection behind source high-water and assert incomplete result,
  lag, and checkpoint.
- [ ] Inject failure between node/edge writes and checkpoint; assert checkpoint
  does not advance.
- [ ] Inject a false merge, apply its recorded inverse/tombstone batch, and
  assert the prior complete graph is restored while immutable sources remain.
- [ ] Reapply the same batch/rollback and assert idempotent results.

### 2.8 Migration/rollback rehearsal

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
