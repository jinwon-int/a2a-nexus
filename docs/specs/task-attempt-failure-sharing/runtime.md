# Runtime adoption — slice 1 (#1799)

Refs #1799 (parent #1635 P2-B). The frozen source-only contract in
[spec.md](./spec.md) is unchanged; this document records the first bounded
runtime slice and its rollout/rollback contract.

## What slice 1 adds

- `packages/broker/src/task-attempt/record.ts` — runtime implementation of
  the closed record contract: grammars, vocabularies, canonical JSON, framed
  digests. The test suite cross-validates every golden fixture record and its
  digest vectors against this module, so the runtime and the conformance
  checker cannot drift silently.
- `packages/broker/src/task-attempt/store.ts` — durable SQLite store with the
  exact spec §6 boundary results (`accepted`, `idempotent_replay`,
  `same_key_payload_conflict`, `contract_rejected`), re-validated reads that
  fail closed on corrupted rows, and the private random alias ledger
  (broker-local ids never enter a record; spec §2).
- `packages/broker/src/task-attempt/producer.ts` — broker-execution producer.
  Honesty rules: `failed` maps only to
  `execution_failure/producer_reported_failure`; supersession is reported only
  from an explicit recorded cancellation kind; `attemptOrdinal` comes from the
  explicit `retryOfTaskId` lineage, never from retry counters or timestamps.
  A snapshot the closed vocabulary cannot express is skipped, not approximated.
- Broker wiring: terminal transitions (`completeTask`, `failTask`,
  `cancelTask`) additionally emit a record when — and only when — a store was
  injected. Emission is advisory and fail-open: store errors are counted in
  `taskAttemptRecordDiagnostics()` and never affect task execution.

## Rollout / rollback

| Mode | How | Effect |
| --- | --- | --- |
| off (default) | do not pass `taskAttemptRecordStore` | surface fully absent; broker behavior byte-identical |
| record | inject a `TaskAttemptRecordStore` via `InMemoryA2ABrokerOptions.taskAttemptRecordStore` | terminal transitions also write attempt records to the store's own SQLite file |

Rollback is removal of the injection. The store uses its own database file —
no broker state schema change, no migration, and no cleanup required beyond
deleting that file. Live activation on a production broker remains a separate
operator approval with an exact target and rollback, per the issue's safety
boundary.

## Retention and byte budget (slice 1 state)

Records are bounded by construction (closed ASCII fields, ≤ 1024 ordinals per
retry root). Slice 1 ships no pruning/export path and no automatic retention;
the operator owns the store file lifecycle. A retention/pruning contract is
deliberately deferred to the read-path slice, where consumption patterns are
known.

## Deferred to later slices

- Dispatcher preflight read path (`TaskAttemptHistoryPreflightResponseV1`)
  and the public/operator projection split (spec §7–§8).
- `bounded_experiment` runtime producer — connected to the #1796 product
  decision; not preempted here (validation for both variants already ships).
- Retention/pruning/export boundaries.
