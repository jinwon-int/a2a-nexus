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
 * Primitives: this adapter implements the replay, rate, lease, and
 * idempotency commands. Outbox and graph projection are refused with
 * `operation_not_implemented` rather than given a placeholder answer, and
 * there is still no broker runtime wiring.
 *
 * `executeIdempotent` takes no observed instant. Its registered namespaces are
 * `non-expiring-until-prune-proof` with no logical expiry boundary, so a
 * record has no TTL for a clock to be compared against; retention is released
 * by an authorized prune, which is neither this slice nor an adapter decision.
 * A replay returns the STORED outcome rather than deriving it again, so a
 * later caller declaring a different effect under the same key cannot restate
 * what already happened. The catalog check the contract parser already
 * performs is repeated here as defence in depth, and an unregistered namespace
 * is an adapter failure rather than a rejection, because the rejection
 * vocabulary has no code for it.
 *
 * Two orderings in the lease rejection ladder carry weight and are not
 * stylistic. A contender that meets a live holder is told `claim_conflict`
 * before its resource version is even considered — every loser of a claim
 * race also holds a stale version, because the winner moved it, and answering
 * `version_conflict` there would describe the wrong problem. And a caller
 * presenting a superseded fence is told `stale_fence` before owner, expiry, or
 * version are considered, so a fenced-out writer never learns anything about
 * the current holder. The fence it is compared against is the stored
 * high-water mark, not the active claim: release and expiry do not lower it,
 * so an old fence stays stale even when nothing holds the resource.
 *
 * Every primitive runs inside a single `BEGIN IMMEDIATE` boundary that also
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
  digestSharedStateKeyV1,
  parseSharedStateDigestV1,
} from "./shared-state-storage-keyspace-v1.js";
import { evaluateSharedStateIdempotencyPolicyV1 } from "./shared-state-idempotency-v1.js";
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
  "unregistered_idempotency_namespace",
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
type ClaimLeaseInputV1 = CommandInputForV1<"claimLease">;
type ExecuteIdempotentInputV1 = CommandInputForV1<"executeIdempotent">;

/**
 * The three lease commands that must present existing authority. They share a
 * rejection ladder, so they are handled through one shape.
 */
type LeaseAuthorityInputV1 =
  | CommandInputForV1<"renewLease">
  | CommandInputForV1<"mutateWithFence">
  | CommandInputForV1<"releaseLease">;

/**
 * The two operations this slice implements. Every other operation is refused
 * with `operation_not_implemented` rather than answered, because a permissive
 * placeholder answer is indistinguishable from a real decision to a caller.
 */
const IMPLEMENTED_OPERATIONS_V1: readonly OperationV1[] = Object.freeze([
  "consumeReplayNonce",
  "reserveRateLimitCost",
  "claimLease",
  "renewLease",
  "mutateWithFence",
  "releaseLease",
  "executeIdempotent",
] as const);

const LEASE_OPERATIONS_V1: readonly OperationV1[] = Object.freeze([
  "claimLease",
  "renewLease",
  "mutateWithFence",
  "releaseLease",
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

interface LeaseRow {
  readonly owner_key_digest: string | null;
  readonly attempt_key_digest: string | null;
  readonly fencing_token: string;
  readonly resource_version: string;
  readonly lease_expires_at_unix_ms: string | null;
}

/**
 * The state a resource is in before it has ever been claimed. Reading an
 * absent row as this rather than as an error keeps a first claim and a
 * re-claim on the same path.
 */
const UNCLAIMED_LEASE_V1: LeaseRow = Object.freeze({
  owner_key_digest: null,
  attempt_key_digest: null,
  fencing_token: "0",
  resource_version: "0",
  lease_expires_at_unix_ms: null,
});

function optionalText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function readLease(
  db: DatabaseSync,
  namespace: string,
  resourceKeyDigest: string,
): LeaseRow | null | undefined {
  const row = db
    .prepare(
      `SELECT owner_key_digest, attempt_key_digest, fencing_token,
              resource_version, lease_expires_at_unix_ms
         FROM shared_state_lease
        WHERE namespace = ? AND resource_key_digest = ?`,
    )
    .get(namespace, resourceKeyDigest) as
    | Record<string, unknown>
    | undefined;
  if (row === undefined) return null;
  const owner = optionalText(row.owner_key_digest);
  const attempt = optionalText(row.attempt_key_digest);
  const expires = optionalText(row.lease_expires_at_unix_ms);
  if (owner === undefined || attempt === undefined || expires === undefined) {
    return undefined;
  }
  if (
    typeof row.fencing_token !== "string"
    || typeof row.resource_version !== "string"
  ) {
    return undefined;
  }
  return {
    owner_key_digest: owner,
    attempt_key_digest: attempt,
    fencing_token: row.fencing_token,
    resource_version: row.resource_version,
    lease_expires_at_unix_ms: expires,
  };
}

/**
 * Derives the attempt key a successful claim reports.
 *
 * The contract makes `attemptKeyDigest` an output of `claimLease` and an input
 * to the other three lease commands, so the adapter must produce it. Its two
 * components are fixed by the closed keyspace: `resourceId` and
 * `attemptNumber`.
 *
 * `resourceId` is bound to the resource key digest, which is the only
 * resource-identifying material the adapter holds — a caller passes a digest,
 * never the pre-image. `attemptNumber` is bound to the fencing token the claim
 * just took. The fence increases on claim and only on claim, so one attempt
 * number belongs to exactly one claim, which is the binding the conformance
 * harness checks.
 */
function deriveAttemptKeyDigest(
  namespace: string,
  resourceKeyDigest: string,
  fencingToken: string,
): string | null {
  const built = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain: "broker.lease.attempt-key",
    namespace,
    components: [
      { field: "resourceId", type: "utf8", value: resourceKeyDigest },
      { field: "attemptNumber", type: "uint", value: fencingToken },
    ],
  });
  return built.ok ? built.value.digest : null;
}

/**
 * Derives the outcome digest a first execution reports.
 *
 * Like `attemptKeyDigest`, the contract makes `outcomeDigest` an output of
 * `executeIdempotent` and never an input, so the adapter must produce it. Its
 * two components are fixed by the closed keyspace: `outcomeType` and
 * `outcomeBody`.
 *
 * Both are bound to what the caller declared the effect to be. `outcomeType`
 * is the effect kind, which is a closed vocabulary value. `outcomeBody` is the
 * domain mutation digest's hash, because the outcome of this operation is
 * whatever that mutation produced — V1 executes no effect of its own and has
 * nothing else to bind to. Two executions declaring the same mutation
 * therefore derive the same outcome, which is the stability the contract asks
 * for.
 */
function deriveOutcomeDigest(
  input: ExecuteIdempotentInputV1,
): string | null {
  const mutation = parseSharedStateDigestV1(
    input.effect.domainMutationDigest,
    { domain: "broker.idempotency.domain-mutation" },
  );
  if (!mutation.ok) return null;
  const built = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain: "broker.idempotency.outcome",
    namespace: input.namespace,
    components: [
      { field: "outcomeType", type: "utf8", value: input.effect.kind },
      { field: "outcomeBody", type: "bytes", value: mutation.value.hex },
    ],
  });
  return built.ok ? built.value.digest : null;
}

interface IdempotencyRow {
  readonly payload_fingerprint: string;
  readonly outcome_digest: string;
  readonly retention_policy_version: string;
}

function readIdempotency(
  db: DatabaseSync,
  namespace: string,
  keyDigest: string,
): IdempotencyRow | null | undefined {
  const row = db
    .prepare(
      `SELECT payload_fingerprint, outcome_digest, retention_policy_version
         FROM shared_state_idempotency
        WHERE namespace = ? AND key_digest = ?`,
    )
    .get(namespace, keyDigest) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  if (
    typeof row.payload_fingerprint !== "string"
    || typeof row.outcome_digest !== "string"
    || typeof row.retention_policy_version !== "string"
  ) {
    return undefined;
  }
  return {
    payload_fingerprint: row.payload_fingerprint,
    outcome_digest: row.outcome_digest,
    retention_policy_version: row.retention_policy_version,
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

      switch (command.operation) {
        case "consumeReplayNonce":
          outcome = this.#consumeReplayNonce(command.input, time.value);
          break;
        case "reserveRateLimitCost":
          outcome = this.#reserveRateLimitCost(command.input, time.value);
          break;
        case "claimLease":
          outcome = this.#claimLease(command.input, time.value);
          break;
        case "executeIdempotent":
          outcome = this.#executeIdempotent(command.input);
          break;
        default:
          // Not a fallthrough: an operation added to the implemented list
          // without a case here must not silently take the lease path.
          if (!LEASE_OPERATIONS_V1.includes(command.operation)) {
            this.#db.exec("ROLLBACK");
            return failure("operation_not_implemented");
          }
          outcome = this.#leaseAuthorityCommand(
            command.operation,
            command.input as LeaseAuthorityInputV1,
            time.value,
          );
          break;
      }
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
   * Executes a keyed effect at most once.
   *
   * This command takes no observed instant. The registered namespaces are
   * `non-expiring-until-prune-proof` with no logical expiry boundary, so an
   * idempotency record has no TTL to compare a clock against — inventing one
   * would be the permissive answer in reverse. Retention is released by an
   * authorized prune, which is not this slice and not an adapter decision.
   */
  #executeIdempotent(
    input: ExecuteIdempotentInputV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
    const operation = V.operations[6];

    // Idempotency namespaces are registered, not free-form: the catalog fixes
    // which retention policy and effect kind each one may use. The existing
    // section 2.2 evaluator decides that, so no policy rule is restated here.
    const policy = evaluateSharedStateIdempotencyPolicyV1({
      namespace: input.namespace,
      retentionPolicyVersion: input.retentionPolicyVersion,
      effectKind: input.effect.kind,
    });
    if (!policy.ok) {
      // Only a retention or effect disagreement has a rejection reason code.
      // An unregistered namespace has none, so it is an adapter failure rather
      // than a decision — answering a contract rejection the vocabulary does
      // not contain would be inventing one.
      if (
        policy.error.code === "retention_policy_mismatch"
        || policy.error.code === "effect_policy_mismatch"
        || policy.error.code === "unknown_retention_policy_version"
      ) {
        return rejectedEnvelope(operation, "retention_policy_mismatch");
      }
      return failure("unregistered_idempotency_namespace");
    }

    const existing = readIdempotency(
      this.#db,
      input.namespace,
      input.keyDigest,
    );
    if (existing === undefined) return failure("store_failure");

    if (existing !== null) {
      // Same key, different payload. The caller reused a key for different
      // work, which is the one thing idempotency must never absorb.
      if (existing.payload_fingerprint !== input.payloadFingerprint) {
        return rejectedEnvelope(operation, "idempotency_conflict");
      }
      // A replay returns the stored outcome rather than deriving it again, so
      // the answer stays identical even if derivation ever changed.
      return committedEnvelope(operation, {
        decision: V.operationDecisions.executeIdempotent[1],
        outcomeDigest: existing.outcome_digest,
      });
    }

    const outcomeDigest = deriveOutcomeDigest(input);
    if (outcomeDigest === null) return failure("adapter_unavailable");

    this.#db
      .prepare(
        `INSERT INTO shared_state_idempotency
           (namespace, key_digest, payload_fingerprint, outcome_digest,
            retention_policy_version)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.namespace,
        input.keyDigest,
        input.payloadFingerprint,
        outcomeDigest,
        input.retentionPolicyVersion,
      );

    return committedEnvelope(operation, {
      decision: V.operationDecisions.executeIdempotent[0],
      outcomeDigest,
    });
  }

  /**
   * Reads a lease row, mapping an absent row to the unclaimed state so a
   * first claim and a re-claim take the same path.
   */
  #leaseRow(
    namespace: string,
    resourceKeyDigest: string,
  ): LeaseRow | undefined {
    const row = readLease(this.#db, namespace, resourceKeyDigest);
    if (row === undefined) return undefined;
    return row ?? UNCLAIMED_LEASE_V1;
  }

  /**
   * True while the stored lease has an owner and has not reached its expiry
   * instant. The boundary rule is the section 2.6 one — `now < expiresAt`, so
   * the instant of expiry is already expired — and it is evaluated by that
   * module rather than re-derived here.
   */
  #leaseIsActive(
    row: LeaseRow,
    time: SharedStateTimeEvaluationV1,
  ): boolean | null {
    if (row.attempt_key_digest === null) return false;
    if (row.lease_expires_at_unix_ms === null) return false;
    const boundary = evaluateSharedStateLogicalBoundaryV1(time, {
      timeVersion: TIME_V.version,
      kind: "lease",
      expiresAtUnixMs: row.lease_expires_at_unix_ms,
    });
    if (!boundary.ok) return null;
    return boundary.value.decision === "active";
  }

  #claimLease(
    input: ClaimLeaseInputV1,
    time: SharedStateTimeEvaluationV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
    const operation = V.operations[2];
    if (!time.safe) return failure("invalid_time_observation");
    const row = this.#leaseRow(input.namespace, input.resourceKeyDigest);
    if (row === undefined) return failure("store_failure");

    // A live claim blocks a new one. This is checked before the version
    // check, so a contender racing a healthy holder is told it lost the
    // resource rather than being told its version is stale.
    const active = this.#leaseIsActive(row, time);
    if (active === null) return failure("store_failure");
    if (active) return rejectedEnvelope(operation, "claim_conflict");

    if (BigInt(input.expectedResourceVersion) !== BigInt(row.resource_version)) {
      return rejectedEnvelope(operation, "version_conflict");
    }

    const expiresAt = deriveSharedStateExpiryV1(
      time,
      String(input.leaseDurationMs),
    );
    if (!expiresAt.ok) return rejectedEnvelope(operation, "lease_expired");

    // The fence rises on claim and only on claim, so it never decreases and
    // an expired or released claim never lets a later claim reuse a fence.
    const fencingToken = (BigInt(row.fencing_token) + 1n).toString();
    const resourceVersion = (BigInt(row.resource_version) + 1n).toString();
    const attemptKeyDigest = deriveAttemptKeyDigest(
      input.namespace,
      input.resourceKeyDigest,
      fencingToken,
    );
    if (attemptKeyDigest === null) return failure("adapter_unavailable");

    this.#db
      .prepare(
        `INSERT INTO shared_state_lease
           (namespace, resource_key_digest, owner_key_digest,
            attempt_key_digest, fencing_token, resource_version,
            lease_expires_at_unix_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, resource_key_digest) DO UPDATE SET
           owner_key_digest = excluded.owner_key_digest,
           attempt_key_digest = excluded.attempt_key_digest,
           fencing_token = excluded.fencing_token,
           resource_version = excluded.resource_version,
           lease_expires_at_unix_ms = excluded.lease_expires_at_unix_ms`,
      )
      .run(
        input.namespace,
        input.resourceKeyDigest,
        input.ownerKeyDigest,
        attemptKeyDigest,
        fencingToken,
        resourceVersion,
        expiresAt.value,
      );

    return committedEnvelope(operation, {
      decision: V.operationDecisions.claimLease[0],
      attemptKeyDigest,
      fencingToken,
      resourceVersion,
      leaseExpiresInMs: input.leaseDurationMs,
    });
  }

  /**
   * The shared rejection ladder for `renewLease`, `mutateWithFence`, and
   * `releaseLease`.
   *
   * Order matters and is not arbitrary. A caller holding a superseded fence is
   * told `stale_fence` before anything else is considered, so a fenced-out
   * writer never learns about the current holder. `releaseLease` alone skips
   * the expiry check: releasing a lease that has already expired is how a
   * holder cleans up after itself, and refusing it would leave the row
   * claimed until something else took over.
   */
  #leaseAuthorityRejection(
    operation: OperationV1,
    input: LeaseAuthorityInputV1,
    row: LeaseRow,
    time: SharedStateTimeEvaluationV1,
  ): string | null | undefined {
    if (BigInt(input.fencingToken) !== BigInt(row.fencing_token)) {
      return "stale_fence";
    }
    if (row.attempt_key_digest === null) {
      return operation === "releaseLease"
        ? "invalid_state_transition"
        : "lease_expired";
    }
    if (input.attemptKeyDigest !== row.attempt_key_digest) {
      return "stale_fence";
    }
    if (input.ownerKeyDigest !== row.owner_key_digest) {
      return "owner_mismatch";
    }
    if (operation !== "releaseLease") {
      const active = this.#leaseIsActive(row, time);
      if (active === null) return undefined;
      if (!active) return "lease_expired";
    }
    if (BigInt(input.expectedResourceVersion) !== BigInt(row.resource_version)) {
      return "version_conflict";
    }
    return null;
  }

  #leaseAuthorityCommand(
    operation: OperationV1,
    input: LeaseAuthorityInputV1,
    time: SharedStateTimeEvaluationV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
    if (!time.safe) return failure("invalid_time_observation");
    const row = this.#leaseRow(input.namespace, input.resourceKeyDigest);
    if (row === undefined) return failure("store_failure");

    const rejection = this.#leaseAuthorityRejection(
      operation,
      input,
      row,
      time,
    );
    if (rejection === undefined) return failure("store_failure");
    if (rejection !== null) return rejectedEnvelope(operation, rejection);

    // Every accepted lease command advances the resource version, so a
    // concurrent holder of a stale version cannot apply a second effect.
    const resourceVersion = (BigInt(row.resource_version) + 1n).toString();

    if (operation === "renewLease") {
      const renew = input as CommandInputForV1<"renewLease">;
      const expiresAt = deriveSharedStateExpiryV1(
        time,
        String(renew.leaseDurationMs),
      );
      if (!expiresAt.ok) return rejectedEnvelope(operation, "lease_expired");
      this.#db
        .prepare(
          `UPDATE shared_state_lease
              SET resource_version = ?, lease_expires_at_unix_ms = ?
            WHERE namespace = ? AND resource_key_digest = ?`,
        )
        .run(
          resourceVersion,
          expiresAt.value,
          input.namespace,
          input.resourceKeyDigest,
        );
      return committedEnvelope(operation, {
        decision: V.operationDecisions.renewLease[0],
        resourceVersion,
        leaseExpiresInMs: renew.leaseDurationMs,
      });
    }

    // A checkpoint mutation keeps the claim; every other mutation kind, and
    // any release, ends it. The fence is left where it is — releasing must
    // never lower it, so the next claim resumes above.
    const endsClaim = operation === "releaseLease"
      || (input as CommandInputForV1<"mutateWithFence">).mutationKind
        !== V.leaseMutationKinds[0];

    if (endsClaim) {
      this.#db
        .prepare(
          `UPDATE shared_state_lease
              SET resource_version = ?, owner_key_digest = NULL,
                  attempt_key_digest = NULL, lease_expires_at_unix_ms = NULL
            WHERE namespace = ? AND resource_key_digest = ?`,
        )
        .run(resourceVersion, input.namespace, input.resourceKeyDigest);
    } else {
      this.#db
        .prepare(
          `UPDATE shared_state_lease SET resource_version = ?
            WHERE namespace = ? AND resource_key_digest = ?`,
        )
        .run(resourceVersion, input.namespace, input.resourceKeyDigest);
    }

    return committedEnvelope(operation, {
      decision: operation === "releaseLease"
        ? V.operationDecisions.releaseLease[0]
        : V.operationDecisions.mutateWithFence[0],
      resourceVersion,
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
