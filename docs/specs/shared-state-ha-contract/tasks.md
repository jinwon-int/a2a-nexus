# Tasks: Shared-State and HA Contract

> **Status:** implementation backlog. Checked items include the completed
> documentation packet and the completed bounded Phase 1 contract/parser and
> keyspace/digest slices.
> Adapter implementations, the conformance harness, runtime integration,
> migration, and operational rollout remain unchecked. Refs #1504.

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
- [ ] Pin adapter-controlled clock, stored time floor, skew tolerance, and
  exact expiry boundaries.
- [ ] Register every idempotency namespace and retention version.
- [ ] Register every outbox stream key and ordering scope.
- [ ] Define bounded public/operator observability schemas and negative leak
  fixtures.
- [x] Add unknown-version/unknown-field/capability-downgrade rejection tests.

## 2. Deterministic conformance harness

All tests use an injected fake clock, seeded deterministic scheduler, explicit
barriers, bounded operation counts, temporary local stores, and no external
network or production data.

### 2.1 Claim/lease concurrency

- [ ] Release 32 contenders at one barrier against one queued resource; assert
  exactly one claim and 31 conflicts.
- [ ] Assert the winner receives one attempt and fence, and every later
  successful claim has a strictly greater fence.
- [ ] Pause the old claimant, advance to expiry, requeue/reclaim, then assert
  old renew/complete/checkpoint writes fail with `stale_fence`.
- [ ] Inject failure before mutation, after task mutation, after audit/outbox
  append, and before commit; assert all-or-none state.
- [ ] Repeat through adapter close/reopen and local child-process singleton
  ownership conflict.

### 2.2 Idempotency concurrency

- [ ] Release 64 same-key/same-fingerprint operations concurrently; assert one
  domain mutation/outbox append and 64 identical stable outcomes.
- [ ] Race same-key/different-fingerprint operations; assert one winner and
  deterministic `idempotency_conflict` for the other without side effect.
- [ ] Inject timeout after commit; resolve by lookup/retry and assert no second
  mutation.
- [ ] Inject rollback between idempotency reservation, domain mutation, outbox,
  and outcome; assert no durable pending reservation or partial effect.
- [ ] Reopen the adapter and assert identical outcomes until explicit
  retention.

### 2.3 Outbox ordering

- [ ] Run eight deterministic producers across at least two streams.
- [ ] Assert unique, strictly increasing sequences and append order within
  each stream; do not require global cross-stream order.
- [ ] Assert same idempotency retry returns the original event ID/sequence.
- [ ] Crash/fail at domain-before-append, append-before-commit, and
  ACK-before-commit boundaries; assert domain+append atomicity and ACK
  replayability.
- [ ] Reopen and reconcile from each cursor; assert no reversal, no duplicate
  ID in one response, unacknowledged replay, and preserved receipt/ACK state.
- [ ] Assert provider-accepted evidence cannot become receipt-confirmed ACK.

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

Later source phases MUST add the targeted adapter test command and broker
package gates once test files exist. This packet does not mark those tests
implemented or passed.
