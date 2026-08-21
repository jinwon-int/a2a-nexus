/**
 * V1 SQLite adapter: lifecycle, exclusive singleton ownership, the monotonic
 * lifecycle epoch, and the replay and rate primitives.
 *
 * Lifecycle and ownership (`spec.md` section 6.2):
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
 *
 * Primitives: this slice implements `consumeReplayNonce` and
 * `reserveRateLimitCost` and nothing else. Lease, idempotency, outbox, and
 * graph projection are refused with `operation_not_implemented` rather than
 * given a placeholder answer, and there is still no broker runtime wiring.
 *
 * Both primitives run inside a single `BEGIN IMMEDIATE` boundary that also
 * contains the trusted-time evaluation and the clock-floor advance, so a
 * decision can never commit against a floor that did not durably move with it.
 * The adapter performs no clock read: the observed instant is supplied by the
 * caller for the same reason the owner token is, and section 4.2's evaluator —
 * not the caller — decides whether that observation is safe. An unsafe
 * observation yields an `unavailable` result carrying the existing
 * `unsafe_clock` reason code and leaves the adapter unwritable, matching what
 * Phase 2.4 already proved at the lifecycle layer.
 *
 * Records outside their logical boundary are left on disk. Deleting them
 * during a decision would make physical cleanup timing observable in a logical
 * answer, which Phase 2.6 forbids; authorized retention execution is a
 * separate, still-unchecked item.
 */

import type { DatabaseSync } from "node:sqlite";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionResultV1,
  type SharedStateStorageLifecycleV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";
import {
  SHARED_STATE_TIME_V1_VALUES as TIME_V,
  deriveSharedStateExpiryV1,
  evaluateSharedStateLogicalBoundaryV1,
  evaluateSharedStateTimeV1,
  type SharedStateTimeEvaluationV1,
} from "./shared-state-time-v1.js";
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
  clockFloorRowId: 1,
  clockProfile: "sqlite-single-writer",
  initialClockFloorUnixMs: "0",
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
  "operation_not_implemented",
  "invalid_time_observation",
  "clock_profile_mismatch",
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

type OperationV1 = (typeof V.operations)[number];

type CommandInputForV1<Operation extends OperationV1> = Extract<
  SharedStateTransactionCommandV1,
  { readonly operation: Operation }
>["input"];

type ConsumeReplayNonceInputV1 = CommandInputForV1<"consumeReplayNonce">;
type ReserveRateLimitCostInputV1 = CommandInputForV1<"reserveRateLimitCost">;

/**
 * The two operations this slice implements. Every other operation is refused
 * with `operation_not_implemented` rather than answered, because a permissive
 * placeholder answer is indistinguishable from a real decision to a caller.
 */
const IMPLEMENTED_OPERATIONS_V1: readonly OperationV1[] = Object.freeze([
  "consumeReplayNonce",
  "reserveRateLimitCost",
] as const);

/**
 * Builds a result envelope and parses it with the contract parser, so the
 * adapter can never emit an envelope it could not itself accept.
 */
function envelope(
  operation: OperationV1,
  tail: Record<string, unknown>,
): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    consistency: {
      model: V.operationConsistency[operation].model,
      scope: V.operationConsistency[operation].scope,
    },
    ...tail,
  });
  if (!parsed.ok) return failure("adapter_unavailable");
  return { ok: true, value: parsed.value };
}

function committedEnvelope(
  operation: OperationV1,
  result: Record<string, unknown>,
): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
  return envelope(operation, {
    status: V.transactionStatuses[0],
    completeness: V.resultCompletenessStates[0],
    result,
  });
}

function rejectedEnvelope(
  operation: OperationV1,
  reasonCode: string,
): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
  return envelope(operation, {
    status: V.transactionStatuses[1],
    completeness: V.resultCompletenessStates[0],
    reasonCode,
  });
}

function unavailableEnvelope(
  operation: OperationV1,
  reasonCode: string,
): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
  return envelope(operation, {
    status: V.transactionStatuses[2],
    completeness: V.resultCompletenessStates[1],
    reasonCode,
  });
}

interface ClockFloorRow {
  readonly clock_profile: string;
  readonly persisted_floor_unix_ms: string;
}

function readClockFloor(db: DatabaseSync): ClockFloorRow | null {
  const row = db
    .prepare(
      `SELECT clock_profile, persisted_floor_unix_ms
         FROM shared_state_clock_floor WHERE id = ?`,
    )
    .get(SHARED_STATE_SQLITE_ADAPTER_V1.clockFloorRowId) as
    | { clock_profile?: unknown; persisted_floor_unix_ms?: unknown }
    | undefined;
  if (row === undefined) return null;
  if (typeof row.clock_profile !== "string") return null;
  if (typeof row.persisted_floor_unix_ms !== "string") return null;
  return {
    clock_profile: row.clock_profile,
    persisted_floor_unix_ms: row.persisted_floor_unix_ms,
  };
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
  readonly #backwardSkewToleranceMs: string;
  #state: LifecycleState = "new";
  #lifecycleEpoch: string | null = null;
  /**
   * The greatest persisted floor this lifecycle has already observed. It is
   * null until the first evaluation after open, exactly as the section 4.2
   * observation contract defines.
   */
  #minimumExpectedFloorUnixMs: string | null = null;

  constructor(input: {
    readonly db: DatabaseSync;
    readonly ownerToken: string;
    readonly backwardSkewToleranceMs: string;
  }) {
    this.#db = input.db;
    this.#ownerToken = input.ownerToken;
    this.#backwardSkewToleranceMs = input.backwardSkewToleranceMs;
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
      // The clock floor row is established here rather than by the schema,
      // because it is bound to this adapter's clock profile and the schema
      // slice deliberately implements no adapter behavior. A row already
      // carrying a different profile is refused, not rewritten: V1 defines no
      // profile migration and silently adopting one would discard the floor
      // guarantee the stored profile was making.
      const floor = readClockFloor(this.#db);
      if (floor === null) {
        this.#db
          .prepare(
            `INSERT INTO shared_state_clock_floor
               (id, clock_profile, persisted_floor_unix_ms)
             VALUES (?, ?, ?)`,
          )
          .run(
            SHARED_STATE_SQLITE_ADAPTER_V1.clockFloorRowId,
            SHARED_STATE_SQLITE_ADAPTER_V1.clockProfile,
            SHARED_STATE_SQLITE_ADAPTER_V1.initialClockFloorUnixMs,
          );
      } else if (
        floor.clock_profile !== SHARED_STATE_SQLITE_ADAPTER_V1.clockProfile
      ) {
        this.#db.exec("ROLLBACK");
        this.#state = "failed";
        return failure("clock_profile_mismatch");
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
    this.#minimumExpectedFloorUnixMs = null;
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
   * Evaluates a caller-supplied observation against the persisted floor.
   *
   * The instant is supplied by the caller for the same reason the owner token
   * is: this slice performs no clock read, so behavior stays deterministic
   * under test. The observation is not trusted by being passed in — section
   * 4.2's evaluator still decides whether it is safe.
   */
  #evaluateTime(
    observedAtUnixMs: string,
  ): SharedStateSqliteAdapterResultV1<SharedStateTimeEvaluationV1> {
    const floor = readClockFloor(this.#db);
    if (floor === null) return failure("schema_not_applied");
    if (floor.clock_profile !== SHARED_STATE_SQLITE_ADAPTER_V1.clockProfile) {
      return failure("clock_profile_mismatch");
    }
    const profile = SHARED_STATE_SQLITE_ADAPTER_V1.clockProfile;
    const requirements = TIME_V.profileRequirements[profile];
    const evaluation = evaluateSharedStateTimeV1(
      {
        kind: TIME_V.kinds.policy,
        timeVersion: TIME_V.version,
        clockProfile: profile,
        clockAuthority: requirements.clockAuthority,
        observationSource: requirements.observationSource,
        timestampUnit: TIME_V.timestampUnit,
        integerEncoding: TIME_V.integerEncoding,
        backwardSkewToleranceMs: this.#backwardSkewToleranceMs,
      },
      {
        kind: TIME_V.kinds.observation,
        timeVersion: TIME_V.version,
        trustBoundary: TIME_V.trustBoundary,
        clockProfile: profile,
        clockAuthority: requirements.clockAuthority,
        observationSource: requirements.observationSource,
        observedAtUnixMs,
        persistedFloorUnixMs: floor.persisted_floor_unix_ms,
        minimumExpectedFloorUnixMs: this.#minimumExpectedFloorUnixMs,
      },
    );
    if (!evaluation.ok) return failure("invalid_time_observation");
    return { ok: true, value: evaluation.value };
  }

  /**
   * Executes one storage V1 command inside a single `BEGIN IMMEDIATE`
   * boundary. This slice implements the replay and rate primitives only.
   *
   * The trusted-time evaluation, the floor advance, and the primitive all sit
   * inside that one transaction, so a decision can never be committed against
   * a floor that did not durably move with it.
   */
  transact(
    command: SharedStateTransactionCommandV1,
    observation: { readonly observedAtUnixMs: string },
  ): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
    if (!IMPLEMENTED_OPERATIONS_V1.includes(command.operation)) {
      return failure("operation_not_implemented");
    }
    const lease = this.beginWrite();
    if (!lease.ok) return lease;

    let began = false;
    let nextFloor: string | null = null;
    let outcome: SharedStateSqliteAdapterResultV1<
      SharedStateTransactionResultV1
    >;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;

      const time = this.#evaluateTime(observation.observedAtUnixMs);
      if (!time.ok) {
        this.#db.exec("ROLLBACK");
        return time;
      }
      // An unsafe clock forbids writes and logical decisions, so the answer is
      // an `unavailable` envelope with unknown completeness rather than a
      // decision, and the adapter stops being writable.
      if (!time.value.safe) {
        this.#db.exec("ROLLBACK");
        this.#state = "failed";
        return unavailableEnvelope(command.operation, "unsafe_clock");
      }
      if (time.value.floorWriteRequired) {
        this.#db
          .prepare(
            `UPDATE shared_state_clock_floor
               SET persisted_floor_unix_ms = ?
             WHERE id = ?`,
          )
          .run(
            time.value.nextPersistedFloorUnixMs,
            SHARED_STATE_SQLITE_ADAPTER_V1.clockFloorRowId,
          );
      }
      nextFloor = time.value.nextPersistedFloorUnixMs;

      outcome = command.operation === "consumeReplayNonce"
        ? this.#consumeReplayNonce(command.input, time.value)
        : this.#reserveRateLimitCost(
          command.input as ReserveRateLimitCostInputV1,
          time.value,
        );
      if (!outcome.ok) {
        this.#db.exec("ROLLBACK");
        return outcome;
      }
      this.#db.exec("COMMIT");
    } catch {
      if (began) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          // Preserve the original failure.
        }
      }
      return failure("store_failure");
    }

    // Only a committed floor may raise the minimum this lifecycle expects.
    this.#minimumExpectedFloorUnixMs = nextFloor;
    return outcome;
  }

  #consumeReplayNonce(
    input: ConsumeReplayNonceInputV1,
    time: SharedStateTimeEvaluationV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
    const operation = V.operations[0];
    // The time module takes canonical decimal strings; the command contract
    // carries durations as integers.
    const expiresAt = deriveSharedStateExpiryV1(time, String(input.ttlMs));
    if (!expiresAt.ok) return rejectedEnvelope(operation, "invalid_expiry");
    if (!time.safe) return rejectedEnvelope(operation, "invalid_expiry");
    const now = BigInt(time.effectiveNowUnixMs);

    const existing = this.#db
      .prepare(
        `SELECT expires_at_unix_ms FROM shared_state_replay_nonce
         WHERE namespace = ? AND key_digest = ? AND nonce_digest = ?`,
      )
      .get(input.namespace, input.keyDigest, input.nonceDigest) as
      | { expires_at_unix_ms?: unknown }
      | undefined;

    if (existing !== undefined) {
      if (typeof existing.expires_at_unix_ms !== "string") {
        return failure("store_failure");
      }
      const boundary = evaluateSharedStateLogicalBoundaryV1(time, {
        timeVersion: TIME_V.version,
        kind: "replay-ttl",
        expiresAtUnixMs: existing.expires_at_unix_ms,
      });
      if (!boundary.ok) return rejectedEnvelope(operation, "invalid_expiry");
      if (boundary.value.decision === "active") {
        return committedEnvelope(operation, {
          decision: V.operationDecisions.consumeReplayNonce[1],
          expiresInMs: Number(BigInt(existing.expires_at_unix_ms) - now),
        });
      }
      // An expired record is consumable again. It is replaced rather than
      // deleted-then-inserted so the row never briefly disappears.
    }

    this.#db
      .prepare(
        `INSERT INTO shared_state_replay_nonce
           (namespace, key_digest, nonce_digest, expires_at_unix_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(namespace, key_digest, nonce_digest)
           DO UPDATE SET expires_at_unix_ms = excluded.expires_at_unix_ms`,
      )
      .run(
        input.namespace,
        input.keyDigest,
        input.nonceDigest,
        expiresAt.value,
      );
    return committedEnvelope(operation, {
      decision: V.operationDecisions.consumeReplayNonce[0],
      expiresInMs: Number(BigInt(expiresAt.value) - now),
    });
  }

  #reserveRateLimitCost(
    input: ReserveRateLimitCostInputV1,
    time: SharedStateTimeEvaluationV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
    const operation = V.operations[1];
    if (!time.safe) return rejectedEnvelope(operation, "invalid_rate_policy");
    const now = BigInt(time.effectiveNowUnixMs);
    const windowMs = BigInt(input.windowMs);

    const rows = this.#db
      .prepare(
        `SELECT event_at_unix_ms, cost, entry_ordinal
           FROM shared_state_rate_cost
          WHERE namespace = ? AND bucket_key_digest = ?
          ORDER BY entry_ordinal`,
      )
      .all(input.namespace, input.bucketKeyDigest) as readonly {
        event_at_unix_ms?: unknown;
        cost?: unknown;
        entry_ordinal?: unknown;
      }[];

    let used = 0n;
    let oldestCounted: bigint | null = null;
    let maxOrdinal = 0;
    for (const row of rows) {
      if (
        typeof row.event_at_unix_ms !== "string"
        || typeof row.cost !== "number"
        || typeof row.entry_ordinal !== "number"
      ) {
        return failure("store_failure");
      }
      maxOrdinal = Math.max(maxOrdinal, row.entry_ordinal);
      const boundary = evaluateSharedStateLogicalBoundaryV1(time, {
        timeVersion: TIME_V.version,
        kind: "rate-window-entry",
        eventAtUnixMs: row.event_at_unix_ms,
        windowMs: String(input.windowMs),
      });
      if (!boundary.ok) {
        return rejectedEnvelope(operation, "invalid_rate_policy");
      }
      // Entries outside the window are left on disk. Deleting them here would
      // make physical cleanup timing observable in a logical decision, which
      // section 2.6 forbids.
      if (boundary.value.decision !== "counted") continue;
      used += BigInt(row.cost);
      const eventAt = BigInt(row.event_at_unix_ms);
      if (oldestCounted === null || eventAt < oldestCounted) {
        oldestCounted = eventAt;
      }
    }

    const cost = BigInt(input.cost);
    const limit = BigInt(input.limit);
    if (used + cost > limit) {
      const resetAt = oldestCounted === null ? now : oldestCounted + windowMs;
      return committedEnvelope(operation, {
        decision: V.operationDecisions.reserveRateLimitCost[1],
        resetInMs: Number(resetAt > now ? resetAt - now : 0n),
      });
    }

    this.#db
      .prepare(
        `INSERT INTO shared_state_rate_cost
           (namespace, bucket_key_digest, event_at_unix_ms, cost,
            entry_ordinal)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.namespace,
        input.bucketKeyDigest,
        time.effectiveNowUnixMs,
        input.cost,
        maxOrdinal + 1,
      );

    const oldest = oldestCounted ?? now;
    return committedEnvelope(operation, {
      decision: V.operationDecisions.reserveRateLimitCost[0],
      remaining: Number(limit - used - cost),
      resetInMs: Number(oldest + windowMs - now),
    });
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
    this.#minimumExpectedFloorUnixMs = null;
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
