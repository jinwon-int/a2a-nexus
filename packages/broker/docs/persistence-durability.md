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

Migration guidance:

- Use the existing SQLite export/import tooling on a copied local state file first.
- Do not run a production migration without operator approval.
- Keep the `json-file` backup until the SQLite broker has completed at least one clean startup and state inspection.
- Treat any adapter shadow/dual-read, schema change, cutover, rollback, broker restart, or replica change as a separately authorized live action under the new contract's [staged plan](../../../docs/specs/shared-state-ha-contract/plan.md).

## Verification

Relevant gates:

- `packages/broker/src/core/store.test.ts` covers canonical JSON writes and corrupt-primary recovery via `.bak`.
- `packages/broker/src/core/store-hot-table-cleanup.test.ts` and SQLite read-path tests cover SQLite snapshot/hot-table behavior.
