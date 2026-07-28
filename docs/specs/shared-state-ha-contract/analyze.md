# Analyze: Shared-State and HA Contract

> **Status:** repository analysis for the proposed documentation-only packet.
> Refs #1504.

## Inputs

- Issue #1504 and its folded claim-graph scenario.
- [spec.md](spec.md) and [clarify.md](clarify.md).
- `packages/broker/src/a2a-http-signature-replay-cache.ts`.
- `packages/broker/src/core/request-security.ts`.
- `packages/broker/src/core/broker.ts`.
- `packages/broker/src/core/store.ts` and
  `sqlite-worker-thread-persistence.ts`.
- `packages/broker/src/core/terminal-event-outbox.ts`.
- `packages/broker/src/core/artifact-repository.ts` and
  `audit-repository.ts`.
- `packages/broker/docs/process-local-security-limits.md`.
- `packages/broker/docs/persistence-durability.md`.
- `docs/known-limitations.md`.

## Current-state findings

| Area | Evidence at the pinned base | Contract consequence |
| --- | --- | --- |
| Replay | `A2AHttpSignatureReplayCache` owns a bounded process `Map`; `createBrokerServer` constructs one cache. | Restart and horizontal-scale reset/split are real. Do not claim cluster replay protection. |
| Rate limit | `InMemoryRateLimiter` owns process buckets and counters; health snapshots currently derive from that instance. | Restart and load-balancer spreading reset/split enforcement. New public signals must avoid per-key identity output. |
| Claims | `claimTask` checks in-memory status, mutates task to `claimed`, assigns `attemptId`, persists, then emits. Stale handling is heartbeat/requeue based. | Safe for one broker owner; there is no store-level distributed claim CAS or fencing token. |
| SQLite | WAL, busy timeout, hot tables, `BEGIN IMMEDIATE`, and durable ACK seams exist. Optional worker-thread persistence is FIFO and opt-in; reads remain synchronous on the main thread. | Good single-writer building blocks, not proof of multi-process coordination or V1 conformance. |
| Idempotency | Some durable domain-specific idempotency exists, including review-lineage source/ledger transactions and live-approval key consumption. There is no one cross-domain shared-state adapter. | Preserve proven atomic domain boundaries; specify a common rule without claiming every path already uses it. |
| Outbox | Stable event IDs, in-memory insertion order, snapshot/hot-table persistence, cursor reconciliation, and receipt-confirmed ACK semantics exist. | Restart durability exists in bounded single-writer mode; cross-process sequence allocation and domain+outbox conformance still need proof. |
| Artifact/audit | Runtime repository seams exist for artifact metadata and append-only audit events; SQLite hot tables can back them. | These are suitable source candidates for a claim-graph projection, but no typed claim graph exists. |
| Startup/readiness | Startup validates security configuration. `/livez` and `/health` exist; there is no shared-state grade/fence contract or `/readyz` topology gate. | Runtime implementation must add a non-serving unsupported-topology path before HA claims. |

## Requirement coverage

- [x] Exact grade catalog is specified.
- [x] All six primitives define source of truth, atomicity, consistency, expiry,
  restart, partition, fail-closed behavior, observability, and adapter
  lifecycle.
- [x] SQLite and a future shared implementation have one versioned semantic
  contract without implying either exists.
- [x] Unsupported multi-process startup/readiness behavior is exact.
- [x] Replay/rate-limit reset risk has a secret-safe signal contract.
- [x] Claim-graph source/projection/completeness/rollback semantics are folded
  into #1504.
- [x] Deterministic local tests, migration stages, cutover, and rollback are
  planned.
- [x] Live and approval-sensitive actions remain separate.

## Safety and liveness trade-offs

| Tension | Resolution |
| --- | --- |
| Backward-compatible alpha startup vs explicit grade | Omitted grade may default to `single-process`, but health reports the default. Multi-process still requires declaration/fencing and cannot silently serve. |
| Availability vs replay/rate-limit uncertainty | Protected writes return unavailable. There is no local permissive fallback. |
| Lease expiry vs duplicate execution | Work may continue on a partitioned worker, but stale fencing prevents its commit after ownership changes. |
| At-least-once outbox vs duplicate provider delivery | Stable IDs and idempotent consumers handle replay; receipt-confirmed ACK remains distinct from provider acceptance. |
| Fast graph reads vs correctness | Stale reads are labeled with checkpoint/lag. Finalization requiring evidence fails on incomplete/unavailable projection. |
| Dual-write migration vs atomicity | The old authority remains canonical during shadow. Cross-backend replication uses a durable journal/outbox; a shadow result never drives live decisions. |
| Rollback availability vs safety | If old storage cannot represent post-cutover state, rollback stops serving instead of discarding fences, idempotency, security windows, or ACK state. |

## Key risks and mitigations

| Risk | Severity | Mitigation in packet |
| --- | --- | --- |
| Grade name overclaims current SQLite security continuity | High | Per-primitive truth is authoritative; public docs preserve the volatile replay/rate caveat. |
| Two processes both believe they are the singleton | Critical | Declaration plus renewable fenced ownership; lost ownership makes all stateful routes non-serving. |
| Retry after ambiguous commit duplicates an effect | Critical | Atomic idempotency outcome with domain mutation/outbox; resolve outcome before retry. |
| Lease expires and old worker commits | Critical | Monotonic fencing token required on every claimed mutation. |
| Outbox row is lost between domain commit and append | Critical | One transaction or fail the domain mutation. |
| Partition is mislabeled as “no evidence path” | High | Claim-graph query has four distinct result states and a completeness checkpoint. |
| Health leaks requesters or claims | High | Aggregates/reason codes only; hashes are explicitly forbidden. |
| Shadow divergence is ignored at cutover | High | Any unexplained divergence blocks cutover; thresholds cannot waive semantic mismatches. |
| Rollback resets nonce/rate window | High | Preserve/import unexpired security state or remain non-serving through its maximum window. |
| Future backend is treated as selected | Medium | Backend class is abstract; no vendor, provision, or HA capability is claimed. |

## Alternatives considered

### Sticky routing without shared state

Rejected as an HA contract. It may reduce exposure but does not preserve replay,
rate limit, claim, or idempotency correctness after failover/rebalance.

### SQLite accessed by multiple broker processes

Rejected as a supported multi-process grade. SQLite can serialize database
writes, but existing broker decisions and projections also live in independent
process memory. Database locking is not the required broker-level topology
fence or lease semantics.

### Separate claim-graph infrastructure

Rejected for this phase. The graph is a read-model projection over existing
authenticated source facts and the same adapter/checkpoint contract.

### Best-effort dual writes

Rejected. The old side remains authoritative until a durable replication
journal and read-only comparison prove the candidate. Cross-backend “write
both and hope” creates unresolvable partial success.

## Open implementation decisions

These must be resolved in a later source-design PR, not assumed here:

| Decision | Required before |
| --- | --- |
| Exact on-disk V1 SQLite schema and migration version | SQLite adapter implementation |
| Exact singleton ownership mechanism for JSON and SQLite | Startup/readiness implementation |
| Clock backward-movement tolerance and operator recovery procedure | Durable expiry implementation |
| Exact rate-limit sliding-window representation and bounded storage policy | Rate-limit adapter implementation |
| Stream-key taxonomy for every outbox producer | Outbox conformance implementation |
| Idempotency namespace/retention registry | Domain integration |
| Source-fact schema and projection version for the claim graph | Claim-graph implementation |
| Candidate shared backend and its native transaction/consistency mapping | Future HA design; no selection made |
| Evidence window and workload used for live shadow cutover | Separately approved migration packet |

None of these gaps prevents review of the semantic contract. All block their
respective implementation/cutover stage.

## Analysis outcome

- [x] Coherent enough for specification review.
- [ ] Packet approved by the required reviewers/operators.
- [ ] Runtime implementation authorized.
- [ ] Adapter/tests implemented.
- [ ] Migration or operational rollout authorized or complete.

