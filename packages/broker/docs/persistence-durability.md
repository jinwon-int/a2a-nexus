# Broker persistence durability

This document is the operator-facing durability contract for the broker persistence backends.

## `json-file` backend

`json-file` is the default single-process backend. It keeps the runtime snapshot in memory and persists a canonical JSON snapshot when broker mutations flush state.

Durable-write sequence:

1. Serialize the broker snapshot with the current state version.
2. Write `STATE_FILE.tmp`.
3. `fsync` the temp file.
4. If an existing `STATE_FILE` is present, copy it to `STATE_FILE.bak` and `fsync` the backup.
5. Atomically `rename` the temp file over `STATE_FILE`.
6. `fsync` the parent directory so the rename is durable on filesystems that require directory sync.

Recovery behavior:

- Missing state file starts from an empty snapshot.
- If the primary snapshot is corrupt/partial and `STATE_FILE.bak` exists, startup loads the one-generation backup.
- If both primary and backup are invalid, startup fails closed instead of silently dropping broker state.

What is **not** guaranteed:

- Mutations after the most recent completed flush can still be lost if the process or host dies before the next flush begins.
- The backend is process-local; it is not a shared store and does not coordinate multiple broker processes.

## SQLite backend

SQLite is available as a higher-durability, single-writer backend and initializes with WAL mode. It requires Node.js `>=22.5` because it uses `node:sqlite`.

The optional worker-thread persistence queue serializes writes through one FIFO writer while reads remain synchronous on the main thread. Neither WAL nor the worker thread makes independently running broker processes a supported cluster. Task decisions and projections still assume one serving broker process, and HTTP-signature replay/rate-limit state remains process-local.

The proposed [shared-state and HA contract](../../../docs/specs/shared-state-ha-contract/spec.md) defines the exact `single-process`, `single-writer-durable`, `multi-process-unsupported`, and future `shared-state-ha` grades. That packet is documentation only: the current SQLite store does not claim `SharedStateStorageAdapterV1` conformance, current startup/readiness does not yet enforce its topology fence, and no shared/HA backend exists.

## Failed durable writes: fail closed (#2523)

A broker mutation changes memory first and then writes the store (on SQLite in-process, inside one transaction per mutation, `commitMutation`). When that write fails (I/O error, full disk, lock timeout, constraint violation), the transaction rolls back, but memory already holds the transition. Before #2523 that drift was silent: the caller got a 500, a retry was idempotent in memory and got 200 with nothing persisted, the drained save hints (including the spend-ledger row) were gone, and after a restart the stale reaper requeued the task.

The broker now fails closed, on every backend and topology:

- **Hints are put back.** The rows a failed write drained (task, audit, spend, late metering, budget and goal rows) return to the pending buffer, so no row is lost with the write. On the worker-thread topology budgets and goals are the exception: their owners already resync memory from the store when a queued write fails.
- **Persistence is degraded.** Every mutation is refused with 503 `state_unavailable` (`message` starts with `broker_persistence_degraded`, `details.reasonCode` is `persistence_degraded`) before it changes memory, and so is the durable ACK of every mutating REST route (the routes that call `awaitDurablePersistenceAck`). That second check covers replies that change nothing because memory already holds the transition: a retried `complete` gets 503, never a 200 for a transition disk does not have. JSON-RPC replies do not wait for a durable ACK (unchanged), so there only the first check applies: a JSON-RPC call that would change state is refused, an idempotent no-op reply is not. Three routes that do not acknowledge a broker mutation run the same check before they write: `POST /operator/cleanup/execute` (deletes store rows directly), `POST /nclex-evaluations/receipts` and `POST /github/webhook`. Reads are still served.
- **What counts as a durable-write failure.** Any non-`BrokerError` escaping a mutation, or any error escaping a transactional batch after the mutation reached its persist step. A `BrokerError` raised before the persist step (validation, `not_found`, `invalid_transition`) is a rejection and leaves the state alone. On the worker-thread topology every rejected queued write counts, whatever the reason, so `queue_saturated` (the bounded write queue is full; the write never ran), `queue_closed`, `worker_crashed` and `worker_unavailable` also open the degraded state (a behaviour change: before #2523 those writes were only logged and their rows lost).
- **How it clears.** By a recovery save: a full save of memory (the hot-table hints are left out, so every hot table is rewritten from the snapshot, plus every pending spend, metering, budget and goal row). The next refused mutation runs one when allowed, and so does each stale-reaper sweep. The first recovery save after a failure may run at once. After a failed one the next waits `persistenceRecoveryProbeIntervalMs` (default 1000 ms), doubled per consecutive failure up to 60 s, and the streak resets when the state clears: a full save is expensive and, in process, runs synchronously on the event loop. While degraded the stale-reaper sweep skips its mutating steps (requeue/dead-letter, the wave-stall audit, goal budget limits) instead of failing; the spend-ledger repair passes and the budget alert evaluation still run. Skipping the goal limits changes no goal state: a pending orphan-goal resume check (#2520) stays set and runs on the first sweep after recovery, and a resume whose queued write failed re-arms that check. In process the save is synchronous, so a mutation whose recovery save succeeds proceeds normally. A restart also clears it: memory reloads from disk.
- **Worker-thread topology.** The write is queued, so the mutation returns before the write runs. A queued write that fails puts its hints back and opens the degraded state when its rejection arrives, before the route's ACK wait returns (that request gets its failure). A recovery save is queued too: the refused request gets 503 and the state clears when the recovery save acks, unless another write failed after it was queued (then the next recovery save carries those rows). Writes already in the queue when the first failure arrives still run; their requests are acknowledged by their own writes.
- **Legacy review-lineage import.** Until the one-time import marker exists, a full save imports the legacy `reviewLineages` and the import validated every record and threw on a rejected one. That failed every full save before #2523; under fail closed it would have failed every recovery save as well, also after a restart (the record comes back from memory). A save now defers the import when a record is rejected: the save succeeds, the records stay in the canonical blob, the marker stays unset, and `broker.review_lineage.legacy_import_deferred` is logged once per process. A later load quarantines the rejected record (#2044) and imports the rest. Blob records are already filtered by that per-record quarantine at load, so in practice only a record the broker itself produced in memory can hit this path.
- **Visibility.** `/health` reports `persistenceWrites` (`state`, `degradedSince`, `lastFailure` with `errorClass` and `message`, `failuresTotal`, `recoveriesTotal`, `recoveryProbe` with `consecutiveFailures`, `intervalMs` and `nextAt`) and sets `ok: false` with an `error` while degraded. The operator alert scan (`GET /alerts`, the operator event stream) carries a critical `persistence_degraded` alert with the error class and the failed recovery saves in its summary and metadata; it opens and resolves right away (the transition announces a state change) and at the latest on the next stale-reaper sweep. The 503 body's `details` carry `degradedSince` and `nextRecoveryAt`. Log lines: `broker.persistence.degraded` (once, when the state opens), `broker.persistence.write_failed` (rate-limited, failures while degraded), `broker.persistence.recovered`; each carries `errorClass`, `failuresTotal` and `failedRecoverySaves`.
- **Known limits.** JSON-RPC replies that change nothing are not refused (above). A recovery save rewrites disk from memory, so if it runs before a budget route's `reloadBudgetFromStore` resync (worker-thread, a failed queued budget write), it can write that write's `budget.created`/`budget.updated` audit row without the budget row (an orphan audit row, no budget). Over HTTP the route resyncs before it answers, so this needs another mutation in between; it is not repaired automatically.

Operational impact: a full disk now makes the broker refuse mutations with 503 instead of acknowledging transitions it could not persist. Workers retry; free the disk and the broker recovers on its own.

### Runbook: persistence degraded

What operators see: `/health` `ok: false` with `persistence degraded since …`, `persistenceWrites.state: "degraded"`, a critical `persistence_degraded` operator alert, workers logging 503 `state_unavailable` (`broker_persistence_degraded`) on claim/complete/heartbeat writes, and one `broker.persistence.degraded` log line followed by rate-limited `broker.persistence.write_failed` lines. Task reads and listings keep working.

Diagnose (read-only):

1. Read `persistenceWrites.lastFailure` (`errorClass`, `message`, `topology`) and `recoveryProbe` (`consecutiveFailures`, `nextAt`) from `/health`, or the matching fields of the log lines.
2. Classify the error:
   - `SQLITE_FULL` / "database or disk is full", `ENOSPC`, I/O errors: storage. Check the free space of the volume holding the SQLite file and its `-wal` file.
   - `SQLITE_BUSY` / "database is locked": another process holds the write lock (a second broker, a backup or `sqlite3` shell on the live file). Find and stop it.
   - constraint violations or a message naming one row or table: a deterministic rejection. Every recovery save rewrites memory in full, so it fails the same way each time; `consecutiveFailures` keeps growing while the cause is unchanged.
   - worker-thread `queue_saturated`: a burst filled the write queue. It usually clears on the next recovery save. `worker_crashed` / `worker_unavailable`: the persistence worker thread is gone, and every later write fails until the process restarts.
3. Fix the cause. The broker retries on its own (next mutation or stale-reaper sweep, backoff up to 60 s between attempts) and logs `broker.persistence.recovered` when a recovery save succeeds. Nothing is lost: memory holds every acknowledged transition and the pending rows, and the recovery save writes them.

When a restart helps (a restart is an operator action that needs approval): it discards memory and reloads from disk. That clears a worker-thread crash (`worker_crashed`/`worker_unavailable`) and a deterministic rejection of a row memory holds but disk refuses. The transitions only memory held are then lost: the one whose write failed, plus any the worker-thread queue accepted before the failure was known. The stale reaper requeues those tasks and workers redo them. It does not help with a full disk or a held lock: the broker comes back and degrades again on the first write. Fix those first.

Migration guidance:

- Use the existing SQLite export/import tooling on a copied local state file first.
- Do not run a production migration without operator approval.
- Keep the `json-file` backup until the SQLite broker has completed at least one clean startup and state inspection.
- Treat any adapter shadow/dual-read, schema change, cutover, rollback, broker restart, or replica change as a separately authorized live action under the new contract's [staged plan](../../../docs/specs/shared-state-ha-contract/plan.md).

## Verification

Relevant gates:

- `packages/broker/src/core/store/store.test.ts` covers canonical JSON writes and corrupt-primary recovery via `.bak`.
- `packages/broker/src/core/store-hot-table-cleanup.test.ts` and SQLite read-path tests cover SQLite snapshot/hot-table behavior.
- `packages/broker/src/core/store/commit-mutation-fail-closed.test.ts` forces a store write failure with a SQLite trigger and covers the fail-closed behaviour (#2523) on both in-process wirings, both load sources, the worker-thread topology and over HTTP.
