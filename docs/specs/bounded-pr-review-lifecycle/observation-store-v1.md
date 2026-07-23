# Review-lineage observation store v1

Phase 9 adds a source-only SQLite reference implementation for applying one
normalized Phase 8 observation atomically. It proves restart-safe idempotency
and exact-subject compare-and-set behavior before any producer or broker
runtime call site exists.

The implementation is
`packages/broker/src/core/review-lineage-observation-store.ts`.

## Atomic apply contract

`DurableReviewLineageObservationStore.apply()` accepts only a normalized
`ProjectedReviewLineageObservation`. One `BEGIN IMMEDIATE` transaction owns:

1. lookup of the derived idempotency key;
2. same-payload replay or different-payload conflict;
3. lineage existence and exact `intentHash` / `headSha` / `diffHash` check;
4. the existing pure lifecycle engine transition;
5. a version-guarded lineage insert/update;
6. insertion of the stable observation outcome.

The lineage row and ledger row commit together. An error before commit rolls
both back. A retry after commit reads the ledger and cannot call the engine
again.

## Stable outcomes

- `applied`: the lineage and ledger committed together.
- `replayed`: the same key and payload fingerprint already committed; the
  original stable outcome is returned without another transition.
- `idempotency_conflict`: the key exists with a different payload fingerprint.
- `missing_lineage`: an event targeted a lineage that did not exist.
- `subject_conflict`: create found an existing lineage, or any exact-subject
  field differed.
- `transition_rejected`: the normalized command could not be accepted by the
  existing engine.

`missing_lineage`, `subject_conflict`, and `transition_rejected` are recorded.
Their later replay therefore cannot change merely because lineage state changed
after the first attempt.

## Persistence and privacy

The reference schema uses two versioned, detached tables in one SQLite
database:

- a lineage table containing the engine record plus a monotonic record version
  and indexed subject columns;
- an idempotency ledger containing only the derived key, payload fingerprint,
  lineage id, stable outcome, expected-subject fingerprint, resulting
  state/version, redacted effect codes, and observation time.

The ledger does not store the raw envelope, producer/source event identifiers,
prompts, provider output, rejected values, or full intent/finding evidence.
Effect strings that can contain reviewer ids, finding ids, paths, or unknown
input values are reduced to their stable code before persistence and replay.
The lineage table necessarily contains the engine record, but this source-only
reference is populated only by deterministic test data.

## Proved behavior

Temporary-file SQLite tests cover:

- close/reopen restart replay;
- two independent connections racing on the same command (`applied` once,
  `replayed` once);
- same-key/different-payload conflict without mutation;
- stable missing-lineage and subject-conflict replay;
- independent intent/head/diff mismatch rejection;
- forced ledger-insert failure rolling back a preceding lineage write;
- absence of raw producer/source/free-text material from ledger rows.

## Integration boundary

This phase does not add these detached tables to the production broker
database, broker snapshot, persistence queue, HTTP API, task completion,
retry/finalizer flow, or a producer. Snapshot state and a separate ledger must
not be connected with independent commit boundaries.

A future broker integration needs a separate review proving that the canonical
lineage state and ledger participate in the same production SQLite transaction.
Producer completeness, retention duration, pruning/export policy, a real
30-terminal-lineage cohort, deployment, and runtime defaults remain separate
gates.
