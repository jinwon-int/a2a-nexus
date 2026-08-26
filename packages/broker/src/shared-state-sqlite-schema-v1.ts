/**
 * V1 SQLite schema for `a2a.shared-state.storage/v1` — tables and migration
 * only.
 *
 * This module creates and validates the durable shape the V1 adapter will
 * later write through. It implements no adapter, no transaction boundary, no
 * primitive, no clock read, no ownership acquisition, and no broker runtime
 * wiring. Applying the schema performs exactly one thing: it makes the tables
 * exist and records the schema version, or it fails closed.
 *
 * The schema lives in its own database file, separate from the legacy
 * `broker_*` store. That separation is required rather than stylistic:
 * `spec.md` section 6.2 forbids nested or cross-adapter transactions in V1,
 * section 6.3 states the contract does not imply that a generic existing
 * SQLite store already conforms, and the closed vocabulary keeps
 * `legacy-sqlite` and `sqlite-single-writer` as distinct backend classes.
 * Sharing the legacy connection is impossible (SQLite rejects a nested
 * `BEGIN IMMEDIATE`) and sharing the legacy file makes the two writers block
 * each other.
 *
 * The table set is derived from what section 6.2 requires an adapter
 * replacement to preserve — keys, fingerprints, fences, sequence numbers,
 * expiry instants, projection checkpoints, and stable outcomes — plus the
 * clock floor of section 4.2 and the ownership/lifecycle epoch of section 6.2.
 */

import type { DatabaseSync } from "node:sqlite";

export const SHARED_STATE_SQLITE_SCHEMA_V1 = Object.freeze({
  kind: "SharedStateSqliteSchemaV1",
  /**
   * Independent of the legacy store's `SQLITE_SCHEMA_VERSION`. The two live in
   * separate files and evolve separately.
   */
  schemaVersion: 1,
  contractVersion: "a2a.shared-state.storage/v1",
  metaTable: "shared_state_meta",
  tables: Object.freeze([
    "shared_state_meta",
    "shared_state_ownership",
    "shared_state_clock_floor",
    "shared_state_replay_nonce",
    "shared_state_rate_cost",
    "shared_state_lease",
    "shared_state_idempotency",
    "shared_state_idempotency_outbox_link",
    "shared_state_outbox",
    "shared_state_graph_source",
    "shared_state_graph_batch",
    "shared_state_graph_projection",
  ] as const),
} as const);

export const SHARED_STATE_SQLITE_SCHEMA_ERROR_CODES_V1 = Object.freeze([
  "schema_read_failed",
  "schema_write_failed",
  "schema_version_mismatch",
  "contract_version_mismatch",
  "schema_table_missing",
  "schema_not_applied",
] as const);

export type SharedStateSqliteSchemaErrorCodeV1 =
  (typeof SHARED_STATE_SQLITE_SCHEMA_ERROR_CODES_V1)[number];

export type SharedStateSqliteSchemaResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: SharedStateSqliteSchemaErrorCodeV1 };
    };

export interface SharedStateSqliteSchemaStateV1 {
  readonly kind: typeof SHARED_STATE_SQLITE_SCHEMA_V1.kind;
  readonly schemaVersion: number;
  readonly contractVersion: string;
  readonly created: boolean;
  readonly tableCount: number;
}

function failure<T>(
  code: SharedStateSqliteSchemaErrorCodeV1,
): SharedStateSqliteSchemaResultV1<T> {
  return { ok: false, error: Object.freeze({ code }) };
}

/**
 * Exact DDL. Every statement is `IF NOT EXISTS` so applying the schema twice
 * is a no-op, and every table is `STRICT` so a wrong column type fails closed
 * at write time rather than being silently coerced.
 *
 * Digests, versions, sequences, and instants are stored as TEXT because the
 * contract encodes them as canonical decimal strings and digest strings; that
 * keeps the stored bytes identical to the parsed contract values.
 */
const SCHEMA_STATEMENTS_V1: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS shared_state_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT`,

  // Exclusive singleton ownership and the monotonic lifecycle epoch. Slice A
  // creates the row shape only; acquiring ownership is a later slice.
  `CREATE TABLE IF NOT EXISTS shared_state_ownership (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     owner_token TEXT,
     lifecycle_epoch TEXT NOT NULL,
     acquired_at_unix_ms TEXT
   ) STRICT`,

  // Persisted clock floor (spec section 4.2). Never decreases.
  `CREATE TABLE IF NOT EXISTS shared_state_clock_floor (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     clock_profile TEXT NOT NULL,
     persisted_floor_unix_ms TEXT NOT NULL
   ) STRICT`,

  `CREATE TABLE IF NOT EXISTS shared_state_replay_nonce (
     namespace TEXT NOT NULL,
     key_digest TEXT NOT NULL,
     nonce_digest TEXT NOT NULL,
     expires_at_unix_ms TEXT NOT NULL,
     PRIMARY KEY (namespace, key_digest, nonce_digest)
   ) STRICT`,

  `CREATE TABLE IF NOT EXISTS shared_state_rate_cost (
     namespace TEXT NOT NULL,
     bucket_key_digest TEXT NOT NULL,
     event_at_unix_ms TEXT NOT NULL,
     cost INTEGER NOT NULL,
     entry_ordinal INTEGER NOT NULL,
     PRIMARY KEY (namespace, bucket_key_digest, entry_ordinal)
   ) STRICT`,

  // Fences, owner/attempt binding, expiry instant, and resource version.
  `CREATE TABLE IF NOT EXISTS shared_state_lease (
     namespace TEXT NOT NULL,
     resource_key_digest TEXT NOT NULL,
     owner_key_digest TEXT,
     attempt_key_digest TEXT,
     fencing_token TEXT NOT NULL,
     resource_version TEXT NOT NULL,
     lease_expires_at_unix_ms TEXT,
     PRIMARY KEY (namespace, resource_key_digest)
   ) STRICT`,

  // Keys, payload fingerprints, and stable outcomes.
  `CREATE TABLE IF NOT EXISTS shared_state_idempotency (
     namespace TEXT NOT NULL,
     key_digest TEXT NOT NULL,
     payload_fingerprint TEXT NOT NULL,
     outcome_digest TEXT NOT NULL,
     retention_policy_version TEXT NOT NULL,
     PRIMARY KEY (namespace, key_digest)
   ) STRICT`,

  // The outbox event an `executeIdempotent` effect promises.
  //
  // This is a caller-owned link, not a registered outbox row. Spec section
  // 5.4.1 states the outbox operations are separate section 6.1 operations
  // rather than aliases for `executeIdempotent`, and the schemas agree: the
  // effect's `retentionPolicyVersion` is a shape-only string while
  // `appendOutbox.retentionPolicyVersion` is the closed section 5.5.1
  // registry. A block that cannot name a registered policy is not describing
  // a registered row, so it gets its own table instead of being written into
  // `shared_state_outbox` with values V1 would have to invent.
  //
  // It is a separate table rather than columns on `shared_state_idempotency`
  // because `CREATE TABLE IF NOT EXISTS` skips the whole statement when the
  // table already exists. Added columns therefore never reach a database that
  // is already in use, and schema validation checks table names rather than
  // columns, so it reports healthy and the first write fails instead. A new
  // table is created normally on that same database.
  `CREATE TABLE IF NOT EXISTS shared_state_idempotency_outbox_link (
     namespace TEXT NOT NULL,
     key_digest TEXT NOT NULL,
     stream_key_digest TEXT NOT NULL,
     event_key_digest TEXT NOT NULL,
     payload_digest TEXT NOT NULL,
     retention_policy_version TEXT NOT NULL,
     PRIMARY KEY (namespace, key_digest)
   ) STRICT`,

  // Per-stream sequence numbers plus receipt and acknowledgment state.
  `CREATE TABLE IF NOT EXISTS shared_state_outbox (
     namespace TEXT NOT NULL,
     stream_key_digest TEXT NOT NULL,
     event_key_digest TEXT NOT NULL,
     idempotency_key_digest TEXT NOT NULL,
     payload_digest TEXT NOT NULL,
     stream_sequence TEXT NOT NULL,
     receipt_state TEXT NOT NULL,
     acknowledgment_state TEXT NOT NULL,
     retention_policy_version TEXT NOT NULL,
     PRIMARY KEY (namespace, stream_key_digest, event_key_digest)
   ) STRICT`,

  `CREATE UNIQUE INDEX IF NOT EXISTS shared_state_outbox_stream_sequence
     ON shared_state_outbox (namespace, stream_key_digest, stream_sequence)`,

  // Retry-binding lookups resolve an append by idempotency key on every
  // appendOutbox; without this index that read walks the stream's whole
  // primary-key range. IF NOT EXISTS reaches databases already in use, and
  // schema validation checks table names, so this is additive.
  `CREATE INDEX IF NOT EXISTS shared_state_outbox_idempotency_key
     ON shared_state_outbox (namespace, stream_key_digest, idempotency_key_digest)`,

  `CREATE TABLE IF NOT EXISTS shared_state_graph_source (
     namespace TEXT NOT NULL,
     source_fact_digest TEXT NOT NULL,
     source_stream_key_digest TEXT NOT NULL,
     node_type TEXT NOT NULL,
     source_sequence TEXT NOT NULL,
     PRIMARY KEY (namespace, source_fact_digest)
   ) STRICT`,

  `CREATE TABLE IF NOT EXISTS shared_state_graph_batch (
     namespace TEXT NOT NULL,
     projection_version TEXT NOT NULL,
     batch_key_digest TEXT NOT NULL,
     inverse_digest TEXT NOT NULL,
     source_sequence_from TEXT NOT NULL,
     source_sequence_through TEXT NOT NULL,
     prior_checkpoint_sequence TEXT NOT NULL,
     rolled_back INTEGER NOT NULL,
     PRIMARY KEY (namespace, projection_version, batch_key_digest)
   ) STRICT`,

  // Projection checkpoints.
  `CREATE TABLE IF NOT EXISTS shared_state_graph_projection (
     namespace TEXT NOT NULL,
     projection_version TEXT NOT NULL,
     checkpoint_sequence TEXT NOT NULL,
     PRIMARY KEY (namespace, projection_version)
   ) STRICT`,
]);

function readMeta(
  db: DatabaseSync,
  key: string,
): SharedStateSqliteSchemaResultV1<string | null> {
  try {
    const row = db
      .prepare(
        `SELECT value FROM ${SHARED_STATE_SQLITE_SCHEMA_V1.metaTable}
         WHERE key = ?`,
      )
      .get(key) as { value?: unknown } | undefined;
    if (row === undefined) return { ok: true, value: null };
    if (typeof row.value !== "string") return failure("schema_read_failed");
    return { ok: true, value: row.value };
  } catch {
    return failure("schema_read_failed");
  }
}

function metaTableExists(db: DatabaseSync): boolean {
  try {
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
      )
      .get(SHARED_STATE_SQLITE_SCHEMA_V1.metaTable) as
      | { name?: unknown }
      | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}

function presentTableCount(db: DatabaseSync): number {
  const tables = SHARED_STATE_SQLITE_SCHEMA_V1.tables;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS present FROM sqlite_master
         WHERE type = 'table' AND name IN (${tables.map(() => "?").join(", ")})`,
      )
      .get(...tables) as { present?: unknown } | undefined;
    return typeof row?.present === "number" ? row.present : Number(row?.present ?? -1);
  } catch {
    return -1;
  }
}

/**
 * Creates the V1 schema if absent and validates it if present.
 *
 * Applying twice is a no-op. A database already carrying a different V1 schema
 * version or a different contract version is rejected rather than migrated:
 * V1 defines no upgrade path yet, so silently adapting to an unexpected
 * version would be the permissive answer.
 *
 * This function does not begin a transaction. `CREATE TABLE IF NOT EXISTS` is
 * individually atomic, and spec section 6.2 forbids nested transactions, so
 * the caller keeps control of any surrounding boundary.
 */
export function applySharedStateSqliteSchemaV1(
  db: DatabaseSync,
): SharedStateSqliteSchemaResultV1<SharedStateSqliteSchemaStateV1> {
  const existed = metaTableExists(db);

  if (existed) {
    const recordedSchema = readMeta(db, "schema_version");
    if (!recordedSchema.ok) return recordedSchema;
    const recordedContract = readMeta(db, "contract_version");
    if (!recordedContract.ok) return recordedContract;
    if (
      recordedSchema.value !== null
      && recordedSchema.value
        !== String(SHARED_STATE_SQLITE_SCHEMA_V1.schemaVersion)
    ) {
      return failure("schema_version_mismatch");
    }
    if (
      recordedContract.value !== null
      && recordedContract.value
        !== SHARED_STATE_SQLITE_SCHEMA_V1.contractVersion
    ) {
      return failure("contract_version_mismatch");
    }
  }

  try {
    for (const statement of SCHEMA_STATEMENTS_V1) db.exec(statement);
  } catch {
    return failure("schema_write_failed");
  }

  try {
    const upsert = db.prepare(
      `INSERT INTO ${SHARED_STATE_SQLITE_SCHEMA_V1.metaTable} (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    upsert.run(
      "schema_version",
      String(SHARED_STATE_SQLITE_SCHEMA_V1.schemaVersion),
    );
    upsert.run(
      "contract_version",
      SHARED_STATE_SQLITE_SCHEMA_V1.contractVersion,
    );
    // Slice A creates the ownership and clock-floor row shapes without
    // claiming ownership or reading a clock. Both stay null/zero until a
    // later slice implements the behavior.
    db.prepare(
      `INSERT INTO shared_state_ownership
         (id, owner_token, lifecycle_epoch, acquired_at_unix_ms)
       VALUES (1, NULL, '0', NULL)
       ON CONFLICT(id) DO NOTHING`,
    ).run();
  } catch {
    return failure("schema_write_failed");
  }

  const tableCount = presentTableCount(db);
  if (tableCount !== SHARED_STATE_SQLITE_SCHEMA_V1.tables.length) {
    return failure("schema_table_missing");
  }

  return {
    ok: true,
    value: Object.freeze({
      kind: SHARED_STATE_SQLITE_SCHEMA_V1.kind,
      schemaVersion: SHARED_STATE_SQLITE_SCHEMA_V1.schemaVersion,
      contractVersion: SHARED_STATE_SQLITE_SCHEMA_V1.contractVersion,
      created: !existed,
      tableCount,
    }),
  };
}

/**
 * Reads the applied schema state without creating anything. Returns
 * `schema_not_applied` when the database has never had the V1 schema applied,
 * so a caller can distinguish "absent" from "wrong version".
 */
export function readSharedStateSqliteSchemaV1(
  db: DatabaseSync,
): SharedStateSqliteSchemaResultV1<SharedStateSqliteSchemaStateV1> {
  if (!metaTableExists(db)) return failure("schema_not_applied");

  const recordedSchema = readMeta(db, "schema_version");
  if (!recordedSchema.ok) return recordedSchema;
  if (recordedSchema.value === null) return failure("schema_not_applied");
  if (
    recordedSchema.value
    !== String(SHARED_STATE_SQLITE_SCHEMA_V1.schemaVersion)
  ) {
    return failure("schema_version_mismatch");
  }

  const recordedContract = readMeta(db, "contract_version");
  if (!recordedContract.ok) return recordedContract;
  if (
    recordedContract.value
    !== SHARED_STATE_SQLITE_SCHEMA_V1.contractVersion
  ) {
    return failure("contract_version_mismatch");
  }

  const tableCount = presentTableCount(db);
  if (tableCount !== SHARED_STATE_SQLITE_SCHEMA_V1.tables.length) {
    return failure("schema_table_missing");
  }

  return {
    ok: true,
    value: Object.freeze({
      kind: SHARED_STATE_SQLITE_SCHEMA_V1.kind,
      schemaVersion: SHARED_STATE_SQLITE_SCHEMA_V1.schemaVersion,
      contractVersion: SHARED_STATE_SQLITE_SCHEMA_V1.contractVersion,
      created: false,
      tableCount,
    }),
  };
}
