/**
 * V1 SQLite adapter skeleton: lifecycle, exclusive singleton ownership, and
 * the monotonic lifecycle epoch.
 *
 * This slice implements the seam every later primitive sits behind, and no
 * primitive itself. There is no `consumeReplayNonce`, no lease, no
 * idempotency, no outbox, no graph projection, no clock read, and no broker
 * runtime wiring. What it does implement is the part `spec.md` section 6.2
 * requires before any of those may run:
 *
 * - `open` validates the schema and contract version and acquires exclusive
 *   ownership before reporting `ready`;
 * - all state-changing calls reject outside `ready`;
 * - `drain` stops new writes;
 * - `close` releases ownership only after drain.
 *
 * Ownership is a compare-and-set on the single `shared_state_ownership` row
 * inside one `BEGIN IMMEDIATE` transaction. A second adapter meeting a live
 * owner token is rejected with `ownership_conflict` rather than waiting or
 * taking over: the default `busy_timeout` is zero and V1 has no ownership
 * lease, so waiting would only convert a clear conflict into a lock error and
 * taking over would be the permissive answer.
 *
 * The lifecycle epoch increments on each successful acquisition and never
 * decreases, including across close and reopen.
 */

import type { DatabaseSync } from "node:sqlite";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateStorageLifecycleV1,
  type SharedStateStorageLifecycleV1,
} from "./shared-state-storage-contract-v1.js";
import {
  SHARED_STATE_SQLITE_SCHEMA_V1,
  readSharedStateSqliteSchemaV1,
} from "./shared-state-sqlite-schema-v1.js";

export const SHARED_STATE_SQLITE_ADAPTER_V1 = Object.freeze({
  kind: "SharedStateSqliteAdapterV1",
  adapterVersion: 1,
  contractVersion: V.versions.contract,
  backendClass: "sqlite-single-writer",
  writerModel: "single",
  ownershipRowId: 1,
} as const);

export const SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1 = Object.freeze([
  "ownership_conflict",
  "schema_version_mismatch",
  "contract_version_mismatch",
  "schema_not_applied",
  "adapter_unavailable",
  "not_ready",
  "already_open",
  "not_open",
  "drain_required",
  "ownership_lost",
  "epoch_regression",
  "store_failure",
] as const);

export type SharedStateSqliteAdapterErrorCodeV1 =
  (typeof SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1)[number];

export type SharedStateSqliteAdapterResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: SharedStateSqliteAdapterErrorCodeV1 };
    };

export interface SharedStateSqliteAdapterWriteLeaseV1 {
  readonly lifecycleEpoch: string;
  readonly ownerToken: string;
}

function failure<T>(
  code: SharedStateSqliteAdapterErrorCodeV1,
): SharedStateSqliteAdapterResultV1<T> {
  return { ok: false, error: Object.freeze({ code }) };
}

type LifecycleState = (typeof V.lifecycleStates)[number];
type LifecycleReasonCode = (typeof V.lifecycleReasonCodes)[number];

function lifecycleEnvelope(
  state: LifecycleState,
  reasonCodes: readonly LifecycleReasonCode[],
): SharedStateStorageLifecycleV1 | null {
  const parsed = parseSharedStateStorageLifecycleV1({
    kind: V.kinds.lifecycle,
    lifecycleVersion: V.versions.lifecycle,
    contractVersion: V.versions.contract,
    state,
    reasonCodes,
  });
  return parsed.ok ? parsed.value : null;
}

interface OwnershipRow {
  readonly owner_token: string | null;
  readonly lifecycle_epoch: string;
}

function readOwnership(db: DatabaseSync): OwnershipRow | null {
  const row = db
    .prepare(
      `SELECT owner_token, lifecycle_epoch FROM shared_state_ownership
       WHERE id = ?`,
    )
    .get(SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId) as
    | { owner_token?: unknown; lifecycle_epoch?: unknown }
    | undefined;
  if (row === undefined) return null;
  if (typeof row.lifecycle_epoch !== "string") return null;
  const token = row.owner_token;
  if (token !== null && typeof token !== "string") return null;
  return { owner_token: token ?? null, lifecycle_epoch: row.lifecycle_epoch };
}

/**
 * The V1 SQLite adapter's lifecycle and ownership seam.
 *
 * The owner token is supplied by the caller rather than generated internally
 * so that ownership behavior is deterministic under test. A real caller is
 * expected to pass a value unique to its process/session.
 */
export class SharedStateSqliteAdapterV1 {
  readonly #db: DatabaseSync;
  readonly #ownerToken: string;
  #state: LifecycleState = "new";
  #lifecycleEpoch: string | null = null;

  constructor(input: {
    readonly db: DatabaseSync;
    readonly ownerToken: string;
  }) {
    this.#db = input.db;
    this.#ownerToken = input.ownerToken;
  }

  get ownerToken(): string {
    return this.#ownerToken;
  }

  get lifecycleEpoch(): string | null {
    return this.#lifecycleEpoch;
  }

  /**
   * Reports the current lifecycle as a parsed contract envelope. `failed`
   * carries the reason that caused it; the transient states carry the request
   * reason the contract defines for them.
   */
  lifecycle(): SharedStateStorageLifecycleV1 | null {
    switch (this.#state) {
      case "ready":
        return lifecycleEnvelope("ready", []);
      case "draining":
        return lifecycleEnvelope("draining", ["drain_requested"]);
      case "closed":
        return lifecycleEnvelope("closed", ["close_requested"]);
      case "opening":
        return lifecycleEnvelope("opening", ["open_requested"]);
      case "failed":
        return lifecycleEnvelope("failed", ["adapter_unavailable"]);
      default:
        return lifecycleEnvelope("new", []);
    }
  }

  /**
   * Validates schema and contract version, then acquires exclusive ownership
   * and advances the lifecycle epoch — all inside one `BEGIN IMMEDIATE`
   * transaction, so two adapters racing the same file cannot both win.
   */
  open(): SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1> {
    if (this.#state === "ready") return failure("already_open");
    if (this.#state === "draining") return failure("drain_required");

    this.#state = "opening";

    const schema = readSharedStateSqliteSchemaV1(this.#db);
    if (!schema.ok) {
      this.#state = "failed";
      switch (schema.error.code) {
        case "schema_version_mismatch":
          return failure("schema_version_mismatch");
        case "contract_version_mismatch":
          return failure("contract_version_mismatch");
        case "schema_not_applied":
          return failure("schema_not_applied");
        default:
          return failure("adapter_unavailable");
      }
    }
    if (
      schema.value.contractVersion
      !== SHARED_STATE_SQLITE_ADAPTER_V1.contractVersion
    ) {
      this.#state = "failed";
      return failure("contract_version_mismatch");
    }

    let acquired: string;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
    } catch {
      this.#state = "failed";
      return failure("adapter_unavailable");
    }
    try {
      const row = readOwnership(this.#db);
      if (row === null) {
        this.#db.exec("ROLLBACK");
        this.#state = "failed";
        return failure("schema_not_applied");
      }
      // A live token belonging to someone else is a conflict, never a wait
      // and never a takeover.
      if (row.owner_token !== null && row.owner_token !== this.#ownerToken) {
        this.#db.exec("ROLLBACK");
        this.#state = "failed";
        return failure("ownership_conflict");
      }
      const next = BigInt(row.lifecycle_epoch) + 1n;
      if (next <= BigInt(row.lifecycle_epoch)) {
        this.#db.exec("ROLLBACK");
        this.#state = "failed";
        return failure("epoch_regression");
      }
      this.#db
        .prepare(
          `UPDATE shared_state_ownership
             SET owner_token = ?, lifecycle_epoch = ?
           WHERE id = ?`,
        )
        .run(
          this.#ownerToken,
          next.toString(),
          SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId,
        );
      this.#db.exec("COMMIT");
      acquired = next.toString();
    } catch {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure; rollback failure only confirms the
        // acquisition did not cleanly complete.
      }
      this.#state = "failed";
      return failure("store_failure");
    }

    this.#lifecycleEpoch = acquired;
    this.#state = "ready";
    const envelope = this.lifecycle();
    if (envelope === null) {
      this.#state = "failed";
      return failure("adapter_unavailable");
    }
    return { ok: true, value: envelope };
  }

  /**
   * The guard every later state-changing command must pass. It rejects
   * outside `ready` and re-verifies that this adapter still holds ownership,
   * so a session whose row was taken over cannot keep writing.
   */
  beginWrite(): SharedStateSqliteAdapterResultV1<
    SharedStateSqliteAdapterWriteLeaseV1
  > {
    if (this.#state !== "ready") return failure("not_ready");
    const epoch = this.#lifecycleEpoch;
    if (epoch === null) return failure("not_ready");

    let row: OwnershipRow | null;
    try {
      row = readOwnership(this.#db);
    } catch {
      return failure("store_failure");
    }
    if (row === null) return failure("store_failure");
    if (row.owner_token !== this.#ownerToken) {
      this.#state = "failed";
      return failure("ownership_lost");
    }
    if (row.lifecycle_epoch !== epoch) {
      this.#state = "failed";
      return failure("ownership_lost");
    }
    return {
      ok: true,
      value: Object.freeze({
        lifecycleEpoch: epoch,
        ownerToken: this.#ownerToken,
      }),
    };
  }

  /**
   * Stops new writes. This slice accepts no writes to be in flight, so drain
   * completes immediately; a later slice with a worker writer reports whether
   * every accepted write reached a committed or rolled-back result.
   */
  drain(): SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1> {
    if (this.#state !== "ready") return failure("not_ready");
    this.#state = "draining";
    const envelope = this.lifecycle();
    if (envelope === null) {
      this.#state = "failed";
      return failure("adapter_unavailable");
    }
    return { ok: true, value: envelope };
  }

  /**
   * Releases ownership, but only after drain. The epoch is left where it is:
   * releasing must never lower it, so the next acquisition resumes above.
   */
  close(): SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1> {
    if (this.#state === "closed") return failure("not_open");
    if (this.#state === "ready") return failure("drain_required");
    if (this.#state !== "draining" && this.#state !== "failed") {
      return failure("not_open");
    }

    if (this.#state === "draining") {
      try {
        this.#db.exec("BEGIN IMMEDIATE");
        const row = readOwnership(this.#db);
        if (row !== null && row.owner_token === this.#ownerToken) {
          this.#db
            .prepare(
              `UPDATE shared_state_ownership SET owner_token = NULL
               WHERE id = ?`,
            )
            .run(SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);
        }
        this.#db.exec("COMMIT");
      } catch {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          // Preserve the original failure.
        }
        this.#state = "failed";
        return failure("store_failure");
      }
    }

    this.#state = "closed";
    this.#lifecycleEpoch = null;
    const envelope = this.lifecycle();
    if (envelope === null) return failure("adapter_unavailable");
    return { ok: true, value: envelope };
  }
}

/**
 * Reads the persisted lifecycle epoch without opening an adapter. Exposed so
 * a test or a later slice can assert the epoch never decreases across
 * close/reopen without acquiring ownership to find out.
 */
export function readSharedStateSqliteLifecycleEpochV1(
  db: DatabaseSync,
): SharedStateSqliteAdapterResultV1<string> {
  const schema = readSharedStateSqliteSchemaV1(db);
  if (!schema.ok) return failure("schema_not_applied");
  if (
    schema.value.schemaVersion
    !== SHARED_STATE_SQLITE_SCHEMA_V1.schemaVersion
  ) {
    return failure("schema_version_mismatch");
  }
  let row: OwnershipRow | null;
  try {
    row = readOwnership(db);
  } catch {
    return failure("store_failure");
  }
  if (row === null) return failure("schema_not_applied");
  return { ok: true, value: row.lifecycle_epoch };
}
