# Production Review-Lineage Observation Store v1

Phase 10 promotes the Phase 9 atomic reference algorithm into the production
SQLite persistence authority. This is a source-only integration. It does not
attach an observation producer or authorize a live database change.

## Canonical authority

`SqliteBrokerStateStore` owns the same `DatabaseSync` connection used by the
review-lineage repository. The dedicated lineage table is canonical:

- `broker_review_lineage_observation_lineages_v1`
- `broker_review_lineage_observation_ledger_v1`
- `broker_review_lineage_observation_meta_v1`

Broker schema version 12 is published only after those tables initialize.
`BrokerSnapshot.reviewLineages` remains a backward-compatible import and
derived export field; it is not a competing write authority.

## Compound observation command

The only production SQLite mutation entry point is
`applyReviewLineageObservation(ProjectedReviewLineageObservation)`.
One `BEGIN IMMEDIATE` transaction owns:

1. durable idempotency replay or conflict lookup;
2. canonical lineage lookup;
3. exact `intentHash` / `headSha` / `diffHash` and record-version comparison;
4. pure lifecycle transition;
5. conditional lineage insert or update;
6. stable redacted outcome insertion;
7. `COMMIT`, or full `ROLLBACK` on any failure.

The broker refreshes its in-memory read projection only after that durable
operation returns. It never changes the `ReviewLineageStore` Map first.
Legacy direct `createReviewLineage` / `recordReviewLineageEvent` calls fail with
`review_lineage_atomic_observation_required` when the configured store exposes
the atomic API.

## Worker-thread persistence

`WorkerThreadProxyStore` enqueues the entire compound command as one bounded
queue entry. `sqlite-worker.ts` receives one
`applyReviewLineageObservation` message and runs the complete transaction on
the worker-owned `SqliteBrokerStateStore`.

The main thread waits for that worker response before refreshing its projection.
The command is never split into a lineage message and a ledger message.

## Legacy snapshot import

The first canonical access imports valid legacy snapshot lineages under the
`legacy_snapshot_import_v1` marker:

- marker lookup, lineage inserts, and marker insert share one transaction;
- existing canonical lineage IDs win via insert-if-absent;
- a later stale snapshot cannot overwrite canonical rows;
- nullable legacy `currentDiffHash` remains readable, but cannot satisfy a
  future exact-subject observation until a complete binding exists;
- worker-thread proxy loads may project the legacy sidecar without importing it
  on the main thread; the worker owner performs import before its first
  compound observation or queued save.

Rollback does not drop the new tables. Older snapshot data remains readable as
compatibility input, but post-Phase-10 canonical updates are intentionally not
dual-written as a second authoritative snapshot history.

## Source boundary

Phase 10 adds an explicit broker method but no caller that produces
observations automatically. It adds no:

- HTTP mutation route;
- task-completion, retry, finalizer, or provider hook;
- deploy, restart, live schema execution, or data migration;
- retention, prune, export, or real-lineage cohort job;
- runtime `enforce` support or default-budget change;
- fixer apply/push, release, tag, secret, or ruleset mutation.

A complete producer/privacy/retention review remains required before any live
record-mode collection.
