# Clarify: Shared-State and HA Contract

> **Status:** resolved questions for the proposed documentation-only packet.
> Refs #1504.

Answers here are normative where they use `MUST`/`SHOULD`. They do not claim
runtime implementation or approval.

## Q1. Are all four deployment-grade names supported modes?

No. They are the complete support catalog:

- `single-process` is the current supported alpha topology.
- `single-writer-durable` is the current supported SQLite topology for durable
  broker lifecycle data, still with process-local replay/rate-limit state.
- `multi-process-unsupported` is a non-serving effective state.
- `shared-state-ha` is reserved future work and unavailable.

The grade name never overrides the per-primitive truth. In particular,
SQLite durability MUST NOT be described as cluster-wide replay protection,
cluster-wide rate limiting, multi-writer task claims, or HA.

## Q2. Does current SQLite satisfy `SharedStateStorageAdapterV1`?

No. Existing SQLite code demonstrates useful building blocks: WAL,
`BEGIN IMMEDIATE`, hot tables, durable review-lineage idempotency, and an
optional FIFO writer thread. The repository does not contain the V1 adapter,
durable replay/rate-limit primitives, topology fence, or full conformance
suite. A later SQLite adapter may reuse those building blocks only after
separate review.

## Q3. What is the source of truth for the claim graph?

Authenticated immutable artifact/audit/task facts are the source of truth.
The typed graph is a read-model projection. Workers publish facts; they do not
write arbitrary “truth” directly into a graph.

A graph query MUST carry projection version, checkpoint, lag, and completeness.
“No evidence path” is valid only when the query is complete at its declared
checkpoint. Unavailable or incomplete projection is not negative evidence.

## Q4. What exactly is a task lease?

Current `claimed` state plus heartbeat/stale requeue is not a distributed
lease. V1 requires an expiry, attempt ID, monotonically increasing fencing
token, and compare-and-set version in durable authority. Expiry makes the old
claim eligible for an atomic transition; it does not silently transfer
ownership. Every write made by a claimed worker MUST present the active
attempt and fence.

## Q5. What does “linearizable” mean here?

It is scoped to one conflict key:

- one replay tuple;
- one rate-limit bucket;
- one task/lease;
- one idempotency key; or
- one outbox stream sequence allocation.

After an accepted operation returns, a later operation against the same key
must observe it. V1 does not require a global order across unrelated keys or
outbox streams.

## Q6. Who supplies time?

The adapter controls production time. HTTP clients and workers do not.
SQLite may use a trusted process clock only with a persisted time floor and
backward-clock readiness guard. A future shared adapter uses its documented
server/backend clock domain. Deterministic tests inject the clock.

Logical expiry occurs at `now >= expiresAt`; cleanup timing does not change
validity.

## Q7. Can replay or rate limiting fail open during a partition?

No. V1 defines no fail-open security route. A confirmed replay is rejected, a
confirmed exhausted bucket is rate-limited, and unavailable/ambiguous
authority produces retryable unavailable. It must not be mislabeled as an
authentication failure or a valid empty bucket.

The current single-process restart reset remains a known supported-alpha risk,
not V1 partition behavior.

## Q8. How long do idempotency records live?

There is no universal default. The operation namespace owns a versioned
retention rule. A key that protects an externally visible or irreversible
effect lives at least as long as the effect can be replayed or retained.
Terminal-outbox creation keys therefore cannot expire while the event or a
retry source remains. Pruning requires separate policy and proof.

## Q9. What outbox order is promised?

Total order is promised only within a declared `streamKey`. IDs and sequences
are stable; sequences strictly increase, but gaps are legal. Consumers use
sequence/order, not timestamps. Delivery is at-least-once until
receipt-confirmed ACK. Provider acceptance is not ACK, and ACK is not prune.

No cross-stream global order is promised.

## Q10. How is unsupported multi-process mode detected?

A later implementation uses both declaration and fencing:

1. configured grade plus expected process/replica count;
2. exclusive, renewable, fenced serving ownership for single-process grades;
3. adapter capability/version checks for HA; and
4. loss-of-ownership monitoring after startup.

An expected count greater than one, an ownership conflict, or multiple serving
owners without an approved shared adapter makes the effective grade
`multi-process-unsupported`. The process must not serve stateful routes.

## Q11. May a single-process broker be ready while reset risk is true?

Yes, because volatile replay/rate-limit continuity is an explicit property of
the supported alpha grade. Readiness says the selected grade is serviceable;
health says which security state resets. An operator policy that requires
durable security continuity must reject that grade.

This exception does not permit a detected multi-process topology to serve.

## Q12. What is safe health data?

Version strings, enum states, booleans, ages, coarse pressure bands, bounded
counts, and reason codes are safe. Raw or hashed keys, nonces, requesters,
workers, tasks, lease owners, event IDs, stream keys, receipts, graph nodes,
claim text, artifact paths, provider IDs, credentials, DB paths, and DSNs are
not.

Hashing an identity does not make it suitable for health output.

## Q13. How is a false claim-graph merge rolled back?

Projection batches are idempotent and record the exact source references,
nodes/edges, prior versions, and inverse/tombstone set. Rollback applies that
record atomically and moves the projection checkpoint/state to a documented
replacement batch. Immutable source facts remain intact. Rollback never edits
the source evidence to make the projection appear correct.

## Q14. Is shadow/dual-write automatically authorized by this packet?

No. Even shadowing live requests changes operational state and may carry
production-derived metadata. Local deterministic shadow tests are source-only;
production shadow writes, dual reads, dual writes, schema changes, backend
provisioning, cutover, and rollback execution each require the exact separate
authorization listed in [plan.md](plan.md).

## Q15. What does packet approval authorize?

Only starting separately reviewed source implementation work against the
approved contract. It does not authorize a migration, deploy/restart, live
traffic, HA promotion, replay/ACK/prune, provider send, release, ruleset or
secret change, merge, or issue close.

