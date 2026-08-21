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

## What slice 2 adds

- `packages/broker/src/task-attempt/views.ts` — runtime implementation of the
  two read-only advisory views the contract already froze:
  `TaskAttemptFailureChannelProjectionV1` (spec §7) and
  `TaskAttemptHistoryPreflightResponseV1` (spec §8), plus fail-closed
  validation of the `TaskAttemptHistoryQueryV1` input.
- `InMemoryA2ABroker.taskAttemptHistoryPreflight(query)` — the dispatcher read
  path. Returns the public-safe closed view, or `undefined` when the surface is
  off, the query is unusable, or the store read failed.
- `InMemoryA2ABroker.taskAttemptReadDiagnostics()` — the operator half of the
  projection split.

The runtime builders are cross-validated against
`fixtures/contract/task-attempt-failure-sharing.json` under canonical
encoding, so the runtime and `test/conformance/check-task-attempt-failure-sharing.mjs`
cannot drift apart silently — the same anti-drift bridge slice 1 built for
records and digest vectors.

### `undefined` is not "no prior failures"

`undefined` means *no usable view*: surface off, unusable query, or a failed
store read. "Asked and found nothing" is a returned view with an empty
`priorFailures`. Collapsing the two would let an advisory read report an
absence it never established.

### Where the runtime deliberately differs from the checker

The conformance checker *rejects* on malformed input; the runtime *excludes*
it. Both are correct for their input: the checker validates a curated fixture,
where a bad record is an authoring error, while the runtime reads a live store,
where a bad row is an operational fact. Spec §9 requires exactly this — bad
data is "no usable data" and must leave task execution unchanged, so one
corrupt row cannot be allowed to take down a dispatcher's preflight. Excluded
rows are counted in `taskAttemptReadDiagnostics().unusableRecords`.

### Public / operator projection split

| View | Contents | Audience |
| --- | --- | --- |
| §7 projection, §8 preflight | closed spec field sets only | dispatcher, operator, any consumer |
| `taskAttemptReadDiagnostics()` | served/rejected/error counts, unusable-row and truncation counts | operator only |

Store health is never folded into the closed views — they have no field for it
and must stay closed. A negative test pins that no operator diagnostic name
appears in a serialized public view.

## Retention, pruning, export, and byte budget (slice 2)

Slice 1 deferred this contract to the read-path slice "where consumption
patterns are known". They are now known: the preflight reads one retry lineage
at a time via `listByRetryRoot`, and both views are hard-bounded.

**Byte budget.** The largest golden entry canonicalizes to 686 bytes. With the
spec bounds that puts the worst-case projection at ~43 KiB (64 entries) and the
worst-case preflight at ~22 KiB (32 prior failures). Both are bounded by
construction, not by convention.

**Over-bound behavior.** More eligible records than the bound is an
operational fact, not a contract violation — but a view carrying more than the
bound *would* be malformed. The builders therefore sort canonically and keep
the first N, which is deterministic across reads, and report the dropped count
in `truncatedEntries`. Truncation is never silent and never appears inside the
closed view.

**Retention and pruning.** Still operator-owned, and deliberately still not
automated: the store uses its own SQLite file, so retention is that file's
lifecycle. Pruning by retry root is safe (the preflight reads one lineage at a
time); pruning by ordinal *within* a lineage is not — it would silently shorten
a preflight's history and make an advisory view understate what is known.
Any future automated pruning must therefore be lineage-granular.

**Export.** No export path ships. The records are public-safe by construction,
but the alias ledger (`broker_task_attempt_alias_v1`) is private broker-local
state and must never be exported with them — exporting both together would
re-link public aliases to local identifiers and undo spec §2.

## Deferred to later slices

- `bounded_experiment` runtime producer — connected to the #1796 product
  decision; not preempted here (validation for both variants already ships,
  and slice 2's read path serves the experiment variant if records ever exist).
- An exchange write, HTTP route, or JSON-RPC method for either view. Slice 2
  adds an in-process read path only.
- Dispatcher enforcement of any kind. The preflight stays advisory:
  `automaticDeny=false`, `retryAuthority=not_provided`.
- Automated retention/pruning execution (contract above, no scheduler).
