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
 * Primitives: this adapter implements the replay, rate, lease, idempotency,
 * claim-graph, and outbox commands. Q2 added the closed `reconcileOutbox`
 * read; Q3 adds the closed `queryGraphEvidencePath` read over the durable
 * source/batch/checkpoint ledger. Broker runtime wiring, retention, and prune
 * behaviour remain absent.
 *
 * Outbox reconciliation takes `BEGIN IMMEDIATE` even though it does not write.
 * That places each page after every durable inline write and gives the declared
 * serializable-per-stream observation. Its opaque cursor carries a versioned
 * stream binding and the last returned sequence; malformed, tampered, or
 * cross-stream reuse returns closed unavailable rather than restarting at the
 * beginning. This says nothing about the future FIFO worker path or its
 * durable-commit ACK boundary.
 *
 * The outbox commands allocate `stream_sequence` themselves. The registry
 * makes that the adapter's job — `adapter-allocated-per-exact-stream-key`,
 * with `callerSequencePolicy: "forbidden"` — and the evaluator enforces it by
 * scanning the whole input tree for a caller-supplied sequence field before it
 * looks at anything else. Sequences are unique and strictly increasing within
 * one exact stream key, gaps allowed, with no order across streams. The
 * idempotency binding is keyed by the producer's `idempotencyKeyDigest` rather
 * than by the event id, because the registered answer is that the same key and
 * payload return the ORIGINAL event id and sequence.
 *
 * Receipt and acknowledgment evidence digests are validated by the contract
 * and then not stored: nothing in V1 reads them back, and adding columns for
 * values no reader consumes would be inventing durable state. What is stored
 * is the state each piece of evidence moved the event to.
 *
 * The claim-graph commands put idempotent replay ahead of every precondition,
 * for the same reason the lease ladder puts `claim_conflict` first: a retrying
 * producer necessarily holds a stale expected sequence, because its own first
 * attempt advanced it, so checking the sequence first would answer
 * `source_sequence_conflict` about a fact that is already durable. Source
 * sequences are one space per namespace rather than per stream — a projection
 * batch names a `[from, through]` range with no stream qualifier, so the range
 * is only meaningful if sequences are unique across the namespace, and the
 * stream key is recorded as provenance instead. A rollback restores the
 * checkpoint the batch was applied over rather than decrementing, so the
 * checkpoint is not monotonic; only the source high-water mark is.
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

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateQueryResultV1,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionResultV1,
  type SharedStateQueryRequestV1,
  type SharedStateQueryResultV1,
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
  evaluateSharedStateOutboxPolicyV1,
  evaluateSharedStateOutboxRetryBindingV1,
} from "./shared-state-outbox-v1.js";
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

export const SHARED_STATE_SQLITE_QUERY_OPERATIONS_V1 = Object.freeze([
  "reconcileOutbox",
  "queryGraphEvidencePath",
] as const);

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
  "unregistered_outbox_registration",
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
type AppendOutboxInputV1 = CommandInputForV1<"appendOutbox">;
type UpdateOutboxReceiptInputV1 = CommandInputForV1<"updateOutboxReceipt">;
type AcknowledgeOutboxInputV1 = CommandInputForV1<"acknowledgeOutbox">;
type AppendGraphSourceInputV1 = CommandInputForV1<"appendGraphSource">;
type ApplyGraphProjectionBatchInputV1 =
  CommandInputForV1<"applyGraphProjectionBatch">;
type RollbackGraphProjectionBatchInputV1 =
  CommandInputForV1<"rollbackGraphProjectionBatch">;

type ReconcileOutboxQueryResultV1 = Extract<
  SharedStateQueryResultV1,
  { readonly operation: "reconcileOutbox" }
>;

type GraphEvidencePathQueryRequestV1 = Extract<
  SharedStateQueryRequestV1,
  { readonly operation: "queryGraphEvidencePath" }
>;

type GraphEvidencePathQueryResultV1 = Extract<
  SharedStateQueryResultV1,
  { readonly operation: "queryGraphEvidencePath" }
>;

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
  "appendOutbox",
  "updateOutboxReceipt",
  "acknowledgeOutbox",
  "appendGraphSource",
  "applyGraphProjectionBatch",
  "rollbackGraphProjectionBatch",
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

function outboxQueryEnvelope(
  tail: Record<string, unknown>,
): SharedStateSqliteAdapterResultV1<ReconcileOutboxQueryResultV1> {
  const parsed = parseSharedStateQueryResultV1({
    kind: V.kinds.queryResult,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: V.queryOperations[0],
    ...tail,
  });
  if (!parsed.ok || parsed.value.operation !== "reconcileOutbox") {
    return failure("adapter_unavailable");
  }
  return { ok: true, value: parsed.value };
}

function outboxQuerySucceededEnvelope(
  result: Record<string, unknown>,
): SharedStateSqliteAdapterResultV1<ReconcileOutboxQueryResultV1> {
  return outboxQueryEnvelope({
    status: V.queryStatuses[0],
    achievedConsistency: V.queryConsistency.reconcileOutbox,
    result,
  });
}

function outboxQueryUnavailableEnvelope(
  reasonCode: (typeof V.queryUnavailableReasonCodes)[number],
): SharedStateSqliteAdapterResultV1<ReconcileOutboxQueryResultV1> {
  return outboxQueryEnvelope({
    status: V.queryStatuses[1],
    achievedConsistency: null,
    reasonCode,
  });
}

function graphQueryEnvelope(
  tail: Record<string, unknown>,
): SharedStateSqliteAdapterResultV1<GraphEvidencePathQueryResultV1> {
  const parsed = parseSharedStateQueryResultV1({
    kind: V.kinds.queryResult,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: V.queryOperations[1],
    ...tail,
  });
  if (!parsed.ok || parsed.value.operation !== "queryGraphEvidencePath") {
    return failure("adapter_unavailable");
  }
  return { ok: true, value: parsed.value };
}

function graphQuerySucceededEnvelope(
  result: Record<string, unknown>,
): SharedStateSqliteAdapterResultV1<GraphEvidencePathQueryResultV1> {
  return graphQueryEnvelope({
    status: V.queryStatuses[0],
    achievedConsistency: V.queryConsistency.queryGraphEvidencePath,
    result,
  });
}

function graphQueryUnavailableEnvelope(
  reasonCode: (typeof V.queryUnavailableReasonCodes)[number],
): SharedStateSqliteAdapterResultV1<GraphEvidencePathQueryResultV1> {
  return graphQueryEnvelope({
    status: V.queryStatuses[1],
    achievedConsistency: null,
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

interface OutboxRow {
  readonly event_key_digest: string;
  readonly idempotency_key_digest: string;
  readonly payload_digest: string;
  readonly stream_sequence: string;
  readonly receipt_state: string;
  readonly acknowledgment_state: string;
}

const OUTBOX_COLUMNS_V1 = `event_key_digest, idempotency_key_digest,
   payload_digest, stream_sequence, receipt_state, acknowledgment_state`;

function toOutboxRow(row: Record<string, unknown> | undefined): OutboxRow | null
  | undefined {
  if (row === undefined) return null;
  if (
    typeof row.event_key_digest !== "string"
    || typeof row.idempotency_key_digest !== "string"
    || typeof row.payload_digest !== "string"
    || typeof row.stream_sequence !== "string"
    || typeof row.receipt_state !== "string"
    || typeof row.acknowledgment_state !== "string"
  ) {
    return undefined;
  }
  return {
    event_key_digest: row.event_key_digest,
    idempotency_key_digest: row.idempotency_key_digest,
    payload_digest: row.payload_digest,
    stream_sequence: row.stream_sequence,
    receipt_state: row.receipt_state,
    acknowledgment_state: row.acknowledgment_state,
  };
}

const OUTBOX_QUERY_CURSOR_PREFIX_V1 = "q1";
const POSITIVE_DECIMAL_V1 = /^[1-9][0-9]{0,39}$/;
const NON_NEGATIVE_DECIMAL_V1 = /^(?:0|[1-9][0-9]{0,39})$/;

function outboxQueryCursorBinding(
  namespace: string,
  streamKeyDigest: string,
  streamSequence: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      V.versions.contract,
      V.versions.query,
      V.queryOperations[0],
      namespace,
      streamKeyDigest,
      streamSequence,
    ]))
    .digest("hex");
}

function encodeOutboxQueryCursor(
  namespace: string,
  streamKeyDigest: string,
  streamSequence: string,
): string {
  return [
    OUTBOX_QUERY_CURSOR_PREFIX_V1,
    streamSequence,
    outboxQueryCursorBinding(namespace, streamKeyDigest, streamSequence),
  ].join(".");
}

function decodeOutboxQueryCursor(
  cursor: string | null,
  namespace: string,
  streamKeyDigest: string,
): string | null {
  if (cursor === null) return "0";
  const parts = cursor.split(".");
  if (parts.length !== 3 || parts[0] !== OUTBOX_QUERY_CURSOR_PREFIX_V1) {
    return null;
  }
  const sequence = parts[1];
  const binding = parts[2];
  if (
    sequence === undefined
    || binding === undefined
    || !POSITIVE_DECIMAL_V1.test(sequence)
    || binding !== outboxQueryCursorBinding(
      namespace,
      streamKeyDigest,
      sequence,
    )
  ) {
    return null;
  }
  return sequence;
}

function readOutboxQueryPage(
  db: DatabaseSync,
  namespace: string,
  streamKeyDigest: string,
  afterSequence: string,
  limit: number,
): readonly OutboxRow[] | null {
  const rows = db
    .prepare(
      `SELECT ${OUTBOX_COLUMNS_V1}
         FROM shared_state_outbox
        WHERE namespace = ? AND stream_key_digest = ?
        ORDER BY length(stream_sequence), stream_sequence`,
    )
    .all(namespace, streamKeyDigest) as readonly Record<string, unknown>[];
  const result: OutboxRow[] = [];
  const eventKeys = new Set<string>();
  let previousSequence = 0n;
  for (const row of rows) {
    const parsed = toOutboxRow(row);
    if (parsed === null || parsed === undefined) return null;
    if (!POSITIVE_DECIMAL_V1.test(parsed.stream_sequence)) return null;
    if (
      !parseSharedStateDigestV1(parsed.event_key_digest, {
        domain: "broker.outbox.event-key",
        namespace,
      }).ok
      || !parseSharedStateDigestV1(parsed.idempotency_key_digest, {
        domain: "broker.outbox.idempotency-key",
        namespace,
      }).ok
      || !parseSharedStateDigestV1(parsed.payload_digest, {
        domain: "broker.outbox.payload",
        namespace,
      }).ok
      || !(V.receiptStates as readonly string[]).includes(
        parsed.receipt_state,
      )
      || !(V.acknowledgmentStates as readonly string[]).includes(
        parsed.acknowledgment_state,
      )
      || (parsed.acknowledgment_state === "acknowledged"
        && parsed.receipt_state !== "confirmed")
      || eventKeys.has(parsed.event_key_digest)
    ) {
      return null;
    }
    const sequence = BigInt(parsed.stream_sequence);
    if (sequence <= previousSequence) return null;
    previousSequence = sequence;
    eventKeys.add(parsed.event_key_digest);
    result.push(parsed);
  }
  if (
    afterSequence !== "0"
    && !result.some((row) => row.stream_sequence === afterSequence)
  ) {
    return null;
  }
  const after = BigInt(afterSequence);
  return result
    .filter((row) => BigInt(row.stream_sequence) > after)
    .slice(0, limit + 1);
}

interface GraphQuerySourceRowV1 {
  readonly sourceFactDigest: string;
  readonly sourceStreamKeyDigest: string;
  readonly nodeType: string;
  readonly sequence: bigint;
}

interface GraphQueryBatchRowV1 {
  readonly from: bigint;
  readonly through: bigint;
  readonly prior: bigint;
  readonly rolledBack: boolean;
}

function readGraphQuerySourceRows(
  db: DatabaseSync,
  namespace: string,
): readonly GraphQuerySourceRowV1[] | null {
  const raw = db
    .prepare(
      `SELECT source_fact_digest, source_stream_key_digest, node_type,
              source_sequence
         FROM shared_state_graph_source
        WHERE namespace = ?
        ORDER BY length(source_sequence), source_sequence`,
    )
    .all(namespace) as readonly Record<string, unknown>[];
  const rows: GraphQuerySourceRowV1[] = [];
  let expected = 1n;
  for (const row of raw) {
    if (
      typeof row.source_fact_digest !== "string"
      || typeof row.source_stream_key_digest !== "string"
      || typeof row.node_type !== "string"
      || typeof row.source_sequence !== "string"
      || !POSITIVE_DECIMAL_V1.test(row.source_sequence)
      || BigInt(row.source_sequence) !== expected
      || !(V.graphNodeTypes as readonly string[]).includes(row.node_type)
      || !parseSharedStateDigestV1(row.source_fact_digest, {
        domain: "broker.claim-graph.source-fact",
        namespace,
      }).ok
      || !parseSharedStateDigestV1(row.source_stream_key_digest, {
        domain: "broker.claim-graph.source-stream-key",
        namespace,
      }).ok
    ) {
      return null;
    }
    rows.push({
      sourceFactDigest: row.source_fact_digest,
      sourceStreamKeyDigest: row.source_stream_key_digest,
      nodeType: row.node_type,
      sequence: expected,
    });
    expected += 1n;
  }
  return rows;
}

function readGraphQueryCheckpoint(
  db: DatabaseSync,
  namespace: string,
  projectionVersion: string,
): { readonly present: boolean; readonly value: bigint } | null {
  const row = db
    .prepare(
      `SELECT checkpoint_sequence
         FROM shared_state_graph_projection
        WHERE namespace = ? AND projection_version = ?`,
    )
    .get(namespace, projectionVersion) as
      | { readonly checkpoint_sequence?: unknown }
      | undefined;
  if (row === undefined) return { present: false, value: 0n };
  if (
    typeof row.checkpoint_sequence !== "string"
    || !NON_NEGATIVE_DECIMAL_V1.test(row.checkpoint_sequence)
  ) {
    return null;
  }
  return { present: true, value: BigInt(row.checkpoint_sequence) };
}

function readGraphQueryBatches(
  db: DatabaseSync,
  namespace: string,
  projectionVersion: string,
  highWater: bigint,
): readonly GraphQueryBatchRowV1[] | null {
  const raw = db
    .prepare(
      `SELECT batch_key_digest, inverse_digest, source_sequence_from,
              source_sequence_through, prior_checkpoint_sequence, rolled_back
         FROM shared_state_graph_batch
        WHERE namespace = ? AND projection_version = ?`,
    )
    .all(namespace, projectionVersion) as readonly Record<string, unknown>[];
  const batches: GraphQueryBatchRowV1[] = [];
  for (const row of raw) {
    if (
      typeof row.batch_key_digest !== "string"
      || typeof row.inverse_digest !== "string"
      || typeof row.source_sequence_from !== "string"
      || typeof row.source_sequence_through !== "string"
      || typeof row.prior_checkpoint_sequence !== "string"
      || typeof row.rolled_back !== "number"
      || !POSITIVE_DECIMAL_V1.test(row.source_sequence_from)
      || !POSITIVE_DECIMAL_V1.test(row.source_sequence_through)
      || !NON_NEGATIVE_DECIMAL_V1.test(row.prior_checkpoint_sequence)
      || (row.rolled_back !== 0 && row.rolled_back !== 1)
      || !parseSharedStateDigestV1(row.batch_key_digest, {
        domain: "broker.claim-graph.projection-batch-key",
        namespace,
      }).ok
      || !parseSharedStateDigestV1(row.inverse_digest, {
        domain: "broker.claim-graph.projection-inverse",
        namespace,
      }).ok
    ) {
      return null;
    }
    const from = BigInt(row.source_sequence_from);
    const through = BigInt(row.source_sequence_through);
    const prior = BigInt(row.prior_checkpoint_sequence);
    if (
      from > through
      || through > highWater
      || prior > highWater
    ) {
      return null;
    }
    batches.push({
      from,
      through,
      prior,
      rolledBack: row.rolled_back === 1,
    });
  }
  return batches;
}

function liveGraphQueryBatches(
  batches: readonly GraphQueryBatchRowV1[],
  checkpoint: bigint,
): readonly GraphQueryBatchRowV1[] | null {
  const byPrior = new Map<string, GraphQueryBatchRowV1>();
  for (const batch of batches) {
    if (batch.rolledBack) continue;
    if (
      batch.from !== batch.prior + 1n
      || batch.through < batch.from
      || byPrior.has(batch.prior.toString())
    ) {
      return null;
    }
    byPrior.set(batch.prior.toString(), batch);
  }

  const ordered: GraphQueryBatchRowV1[] = [];
  let current = 0n;
  while (true) {
    const next = byPrior.get(current.toString());
    if (next === undefined) break;
    ordered.push(next);
    current = next.through;
    if (ordered.length > byPrior.size) return null;
  }
  if (ordered.length !== byPrior.size || current !== checkpoint) return null;
  return ordered;
}

function findGraphEvidencePath(
  adjacency: ReadonlyMap<string, readonly string[]>,
  claimSourceFactDigest: string,
  evidenceSourceFactDigest: string,
  maxPathEdges: number,
): readonly string[] | null {
  if (claimSourceFactDigest === evidenceSourceFactDigest) return null;
  const queue: { readonly node: string; readonly path: readonly string[] }[] = [
    { node: claimSourceFactDigest, path: [claimSourceFactDigest] },
  ];
  const visited = new Set([claimSourceFactDigest]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (current.path.length - 1 >= maxPathEdges) continue;
    for (const next of adjacency.get(current.node) ?? []) {
      if (visited.has(next)) continue;
      const path = [...current.path, next];
      if (next === evidenceSourceFactDigest) return path;
      visited.add(next);
      queue.push({ node: next, path });
    }
  }
  return null;
}

function readGraphQueryResult(
  db: DatabaseSync,
  input: GraphEvidencePathQueryRequestV1["input"],
): Record<string, unknown> | null {
  const sources = readGraphQuerySourceRows(db, input.namespace);
  if (sources === null) return null;
  const highWater = BigInt(sources.length);
  const checkpointState = readGraphQueryCheckpoint(
    db,
    input.namespace,
    input.projectionVersion,
  );
  if (checkpointState === null || checkpointState.value > highWater) {
    return null;
  }
  const checkpoint = checkpointState.value;
  const batches = readGraphQueryBatches(
    db,
    input.namespace,
    input.projectionVersion,
    highWater,
  );
  if (batches === null) return null;
  if (!checkpointState.present && batches.length > 0) return null;
  const live = liveGraphQueryBatches(batches, checkpoint);
  if (live === null) return null;

  const sourceBySequence = new Map(
    sources.map((source) => [
      source.sequence.toString(),
      source.sourceFactDigest,
    ] as const),
  );
  const adjacency = new Map<string, string[]>();
  for (const batch of live) {
    const from = sourceBySequence.get(batch.from.toString());
    if (from === undefined) return null;
    const edges = adjacency.get(from) ?? [];
    for (
      let sequence = batch.from + 1n;
      sequence <= batch.through;
      sequence += 1n
    ) {
      const to = sourceBySequence.get(sequence.toString());
      if (to === undefined) return null;
      edges.push(to);
    }
    adjacency.set(from, edges);
  }

  const sourcePath = findGraphEvidencePath(
    adjacency,
    input.claimSourceFactDigest,
    input.evidenceSourceFactDigest,
    input.maxPathEdges,
  );
  const complete = checkpoint === highWater;
  const common = {
    namespace: input.namespace,
    projectionVersion: input.projectionVersion,
    claimSourceFactDigest: input.claimSourceFactDigest,
    evidenceSourceFactDigest: input.evidenceSourceFactDigest,
    asOfSourceSequence: checkpoint.toString(),
    checkpointSequence: checkpoint.toString(),
    sourceSequenceHighWater: highWater.toString(),
    lag: (highWater - checkpoint).toString(),
  };
  if (sourcePath !== null) {
    return {
      ...common,
      evidence: V.graphEvidenceResults[0],
      completeness: complete ? "complete" : "incomplete",
      sourcePath,
    };
  }
  return {
    ...common,
    evidence: complete
      ? V.graphEvidenceResults[1]
      : V.graphEvidenceResults[2],
    completeness: complete ? "complete" : "incomplete",
    sourcePath: [],
  };
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /\b(?:busy|locked)\b/i.test(error.message);
}

/**
 * Reads the event a producer key already committed on this exact stream.
 *
 * The idempotency binding is keyed by `idempotency_key_digest`, not by the
 * event key: the registry answer is "same key and payload return the original
 * event id and sequence", so the original has to be found by the key the
 * producer retried with rather than by the event id it happened to send.
 */
function readOutboxByIdempotencyKey(
  db: DatabaseSync,
  namespace: string,
  streamKeyDigest: string,
  idempotencyKeyDigest: string,
): OutboxRow | null | undefined {
  return toOutboxRow(
    db
      .prepare(
        `SELECT ${OUTBOX_COLUMNS_V1}
           FROM shared_state_outbox
          WHERE namespace = ? AND stream_key_digest = ?
            AND idempotency_key_digest = ?`,
      )
      .get(namespace, streamKeyDigest, idempotencyKeyDigest) as
      | Record<string, unknown>
      | undefined,
  );
}

function readOutboxByEventKey(
  db: DatabaseSync,
  namespace: string,
  streamKeyDigest: string,
  eventKeyDigest: string,
): OutboxRow | null | undefined {
  return toOutboxRow(
    db
      .prepare(
        `SELECT ${OUTBOX_COLUMNS_V1}
           FROM shared_state_outbox
          WHERE namespace = ? AND stream_key_digest = ?
            AND event_key_digest = ?`,
      )
      .get(namespace, streamKeyDigest, eventKeyDigest) as
      | Record<string, unknown>
      | undefined,
  );
}

/**
 * Allocates the next sequence for one exact stream key.
 *
 * `stream_sequence` is TEXT, so SQL `MAX()` would compare it lexically and
 * answer `"9"` for a stream that already reached `"10"`. The maximum is taken
 * as `BigInt` here for that reason. Gaps are allowed by the registry
 * (`unique-strictly-increasing-gaps-allowed`), so a sequence burned by a
 * rolled-back transaction is never reused and never has to be.
 */
function nextOutboxSequence(
  db: DatabaseSync,
  namespace: string,
  streamKeyDigest: string,
): string | undefined {
  const rows = db
    .prepare(
      `SELECT stream_sequence FROM shared_state_outbox
        WHERE namespace = ? AND stream_key_digest = ?`,
    )
    .all(namespace, streamKeyDigest) as readonly Record<string, unknown>[];
  let highest = 0n;
  for (const row of rows) {
    if (typeof row.stream_sequence !== "string") return undefined;
    if (!POSITIVE_DECIMAL_V1.test(row.stream_sequence)) return undefined;
    const value = BigInt(row.stream_sequence);
    if (value > highest) highest = value;
  }
  return (highest + 1n).toString();
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

  #verifyReadyOwnership(): SharedStateSqliteAdapterResultV1<
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
   * The guard every later state-changing command must pass. It rejects
   * outside `ready` and re-verifies that this adapter still holds ownership,
   * so a session whose row was taken over cannot keep writing.
   */
  beginWrite(): SharedStateSqliteAdapterResultV1<
    SharedStateSqliteAdapterWriteLeaseV1
  > {
    return this.#verifyReadyOwnership();
  }

  /**
   * Runs either closed Q1 query behind its operation-specific read boundary.
   *
   * Q2 added the exact-stream outbox page. Q3 adds the graph evidence-path
   * snapshot but does not promote the broad storage adapter interface or wire
   * a runtime/HTTP caller. Both reads take the write lock so ownership and the
   * durable rows they authorize are observed in one SQLite serialization
   * boundary. This still proves nothing about a future FIFO worker, so
   * 488/489 remain open.
   */
  query(
    request: SharedStateQueryRequestV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1> {
    const parsed = parseSharedStateQueryRequestV1(request);
    if (!parsed.ok) return failure("adapter_unavailable");
    if (parsed.value.operation === "queryGraphEvidencePath") {
      return this.#queryGraphEvidencePath(parsed.value);
    }
    const input = parsed.value.input;

    const lifecycleEpoch = this.#lifecycleEpoch;
    if (this.#state !== "ready" || lifecycleEpoch === null) {
      return failure("not_ready");
    }

    const afterSequence = decodeOutboxQueryCursor(
      input.cursor,
      input.namespace,
      input.streamKeyDigest,
    );
    if (afterSequence === null) {
      return outboxQueryUnavailableEnvelope("authority_unavailable");
    }

    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;

      // Verify ownership under the same serialization boundary as the page,
      // so no token change can land between authorization and observation.
      const ownership = readOwnership(this.#db);
      if (ownership === null) {
        this.#db.exec("ROLLBACK");
        began = false;
        this.#state = "failed";
        return outboxQueryUnavailableEnvelope("authority_unavailable");
      }
      if (
        ownership.owner_token !== this.#ownerToken
        || ownership.lifecycle_epoch !== lifecycleEpoch
      ) {
        this.#db.exec("ROLLBACK");
        began = false;
        this.#state = "failed";
        return outboxQueryUnavailableEnvelope("lost_ownership");
      }

      const rows = readOutboxQueryPage(
        this.#db,
        input.namespace,
        input.streamKeyDigest,
        afterSequence,
        input.limit,
      );
      if (rows === null) {
        this.#db.exec("ROLLBACK");
        began = false;
        return outboxQueryUnavailableEnvelope("authority_unavailable");
      }

      const hasMore = rows.length > input.limit;
      const page = rows.slice(0, input.limit);
      const events = page.map((row) => ({
        eventKeyDigest: row.event_key_digest,
        payloadDigest: row.payload_digest,
        streamSequence: row.stream_sequence,
        receiptState: row.receipt_state,
        acknowledgmentState: row.acknowledgment_state,
      }));
      const last = page[page.length - 1];
      const nextCursor = hasMore && last !== undefined
        ? encodeOutboxQueryCursor(
            input.namespace,
            input.streamKeyDigest,
            last.stream_sequence,
          )
        : null;
      const result = outboxQuerySucceededEnvelope({
        namespace: input.namespace,
        streamKeyDigest: input.streamKeyDigest,
        events,
        hasMore,
        nextCursor,
      });
      if (!result.ok) {
        this.#db.exec("ROLLBACK");
        began = false;
        return outboxQueryUnavailableEnvelope("authority_unavailable");
      }
      this.#db.exec("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          // Preserve the query failure; rollback failure cannot strengthen it.
        }
      }
      return outboxQueryUnavailableEnvelope(
        isSqliteBusy(error) ? "lock_timeout" : "authority_unavailable",
      );
    }
  }

  #queryGraphEvidencePath(
    request: GraphEvidencePathQueryRequestV1,
  ): SharedStateSqliteAdapterResultV1<GraphEvidencePathQueryResultV1> {
    const lifecycleEpoch = this.#lifecycleEpoch;
    if (this.#state !== "ready" || lifecycleEpoch === null) {
      return failure("not_ready");
    }

    let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      began = true;

      const ownership = readOwnership(this.#db);
      if (ownership === null) {
        this.#db.exec("ROLLBACK");
        began = false;
        this.#state = "failed";
        return graphQueryUnavailableEnvelope("authority_unavailable");
      }
      if (
        ownership.owner_token !== this.#ownerToken
        || ownership.lifecycle_epoch !== lifecycleEpoch
      ) {
        this.#db.exec("ROLLBACK");
        began = false;
        this.#state = "failed";
        return graphQueryUnavailableEnvelope("lost_ownership");
      }

      const graph = readGraphQueryResult(this.#db, request.input);
      if (graph === null) {
        this.#db.exec("ROLLBACK");
        began = false;
        return graphQueryUnavailableEnvelope("authority_unavailable");
      }
      const result = graphQuerySucceededEnvelope(graph);
      if (!result.ok) {
        this.#db.exec("ROLLBACK");
        began = false;
        return graphQueryUnavailableEnvelope("authority_unavailable");
      }
      this.#db.exec("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          // Preserve the query failure; rollback failure cannot strengthen it.
        }
      }
      return graphQueryUnavailableEnvelope(
        isSqliteBusy(error) ? "lock_timeout" : "authority_unavailable",
      );
    }
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
        case "appendOutbox":
          outcome = this.#appendOutbox(command.input);
          break;
        case "updateOutboxReceipt":
          outcome = this.#updateOutboxReceipt(command.input);
          break;
        case "acknowledgeOutbox":
          outcome = this.#acknowledgeOutbox(command.input);
          break;
        case "appendGraphSource":
          outcome = this.#appendGraphSource(command.input);
          break;
        case "applyGraphProjectionBatch":
          outcome = this.#applyGraphProjectionBatch(command.input);
          break;
        case "rollbackGraphProjectionBatch":
          outcome = this.#rollbackGraphProjectionBatch(command.input);
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

    // The effect's outbox block is staged before the outcome, in this same
    // transaction, which is the order the Phase 2.2 fault matrix names:
    // outbox staging precedes outcome staging. Nothing reads these four
    // values — not the reference model, not either outcome digest, not this
    // adapter — but the effect declares them durably, so a later authorized
    // reconciliation can tell which outbox event an executed effect promised.
    //
    // They are recorded exactly as supplied. No value is derived, defaulted,
    // or invented, which is what separates this from writing a registered
    // `shared_state_outbox` row.
    this.#db
      .prepare(
        `INSERT INTO shared_state_idempotency_outbox_link
           (namespace, key_digest, stream_key_digest, event_key_digest,
            payload_digest, retention_policy_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.namespace,
        input.keyDigest,
        input.effect.outbox.streamKeyDigest,
        input.effect.outbox.eventKeyDigest,
        input.effect.outbox.payloadDigest,
        input.effect.outbox.retentionPolicyVersion,
      );

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
   * Appends a registered outbox event and allocates its stream sequence.
   *
   * Every policy question — the closed purpose registry, the three policy
   * version bindings, the ordering scope, the recomputed stream key digest,
   * and the caller-sequence scan — is answered by the section 2.3 evaluator.
   * The contract parser already ran it, so this is defence in depth in the
   * same shape `executeIdempotent` uses. What is left for the adapter is
   * exactly two things the evaluator cannot know: whether a row already
   * exists, and what sequence comes next.
   */
  #appendOutbox(
    input: AppendOutboxInputV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
    const operation = V.operations[7];

    // The evaluator's field list is a strict subset of the command input: the
    // three digests below are not policy inputs, and passing them would be
    // answered with `unknown_field` rather than a policy decision.
    const policy = evaluateSharedStateOutboxPolicyV1({
      operation,
      namespace: input.namespace,
      eventPurpose: input.eventPurpose,
      streamKey: input.streamKey,
      streamKeyDigest: input.streamKeyDigest,
      orderingScope: input.orderingScope,
      retentionPolicyVersion: input.retentionPolicyVersion,
      receiptPolicyVersion: input.receiptPolicyVersion,
      acknowledgmentPolicyVersion: input.acknowledgmentPolicyVersion,
    });
    if (!policy.ok) {
      // Only the retention family has a verbatim counterpart in this
      // operation's rejection vocabulary. Every other policy disagreement is
      // reported as an adapter failure rather than approximated onto
      // `ordering_conflict`, which means a sequence conflict and not a
      // rejected policy binding.
      if (
        policy.error.code === "retention_policy_mismatch"
        || policy.error.code === "unknown_retention_policy_version"
        || policy.error.code === "invalid_retention_policy_version"
      ) {
        return rejectedEnvelope(operation, "retention_policy_mismatch");
      }
      return failure("unregistered_outbox_registration");
    }
    // The evaluator recomputed this from the structured stream key and proved
    // it equal to the supplied digest, so the recomputed value is used.
    const streamKeyDigest = policy.value.streamKeyDigest;

    const original = readOutboxByIdempotencyKey(
      this.#db,
      input.namespace,
      streamKeyDigest,
      input.idempotencyKeyDigest,
    );
    if (original === undefined) return failure("store_failure");

    if (original !== null) {
      // Replay or conflict is the retry-binding evaluator's decision, not a
      // comparison restated here. The sequence is supplied on both sides
      // because the adapter is asserting the binding it would return is the
      // original one; a differing payload or event key fails inside.
      const binding = evaluateSharedStateOutboxRetryBindingV1({
        original: {
          namespace: input.namespace,
          idempotencyKeyDigest: original.idempotency_key_digest,
          payloadDigest: original.payload_digest,
          eventKeyDigest: original.event_key_digest,
          streamSequence: original.stream_sequence,
        },
        retry: {
          namespace: input.namespace,
          idempotencyKeyDigest: input.idempotencyKeyDigest,
          payloadDigest: input.payloadDigest,
          eventKeyDigest: input.eventKeyDigest,
          streamSequence: original.stream_sequence,
        },
      });
      if (!binding.ok) {
        if (binding.error.code === "idempotent_retry_conflict") {
          return rejectedEnvelope(operation, "idempotency_conflict");
        }
        return failure("unregistered_outbox_registration");
      }
      return committedEnvelope(operation, {
        decision: V.operationDecisions.appendOutbox[1],
        eventKeyDigest: binding.value.eventKeyDigest,
        streamSequence: binding.value.streamSequence,
      });
    }

    // A different producer key already owns this event id on this stream. The
    // primary key would refuse the insert; answering the conflict is better
    // than letting the constraint surface as a store failure.
    const taken = readOutboxByEventKey(
      this.#db,
      input.namespace,
      streamKeyDigest,
      input.eventKeyDigest,
    );
    if (taken === undefined) return failure("store_failure");
    if (taken !== null) {
      return rejectedEnvelope(operation, "idempotency_conflict");
    }

    const streamSequence = nextOutboxSequence(
      this.#db,
      input.namespace,
      streamKeyDigest,
    );
    if (streamSequence === undefined) return failure("store_failure");

    this.#db
      .prepare(
        `INSERT INTO shared_state_outbox
           (namespace, stream_key_digest, event_key_digest,
            idempotency_key_digest, payload_digest, stream_sequence,
            receipt_state, acknowledgment_state, retention_policy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.namespace,
        streamKeyDigest,
        input.eventKeyDigest,
        input.idempotencyKeyDigest,
        input.payloadDigest,
        streamSequence,
        V.receiptStates[0],
        V.acknowledgmentStates[0],
        input.retentionPolicyVersion,
      );

    return committedEnvelope(operation, {
      decision: V.operationDecisions.appendOutbox[0],
      eventKeyDigest: input.eventKeyDigest,
      streamSequence,
    });
  }

  /**
   * Moves one event's receipt state under compare-and-set.
   *
   * Which transitions the presented evidence permits is the evaluator's
   * decision — including that provider acceptance keeps the event `pending`
   * and that projection evidence may only ever be `pending` to `pending`. The
   * adapter compares the stored state against the expected one and writes.
   */
  #updateOutboxReceipt(
    input: UpdateOutboxReceiptInputV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
    const operation = V.operations[8];

    const policy = evaluateSharedStateOutboxPolicyV1({
      operation,
      namespace: input.namespace,
      eventPurpose: input.eventPurpose,
      streamKey: input.streamKey,
      streamKeyDigest: input.streamKeyDigest,
      orderingScope: input.orderingScope,
      retentionPolicyVersion: input.retentionPolicyVersion,
      receiptPolicyVersion: input.receiptPolicyVersion,
      acknowledgmentPolicyVersion: input.acknowledgmentPolicyVersion,
      receiptEvidenceKind: input.receiptEvidenceKind,
      expectedReceiptState: input.expectedReceiptState,
      newReceiptState: input.newReceiptState,
    });
    if (!policy.ok) {
      // A transition the registered receipt policy does not allow is exactly
      // what this vocabulary calls an invalid state transition.
      if (policy.error.code === "receipt_transition_mismatch") {
        return rejectedEnvelope(operation, "invalid_state_transition");
      }
      return failure("unregistered_outbox_registration");
    }

    const row = readOutboxByEventKey(
      this.#db,
      input.namespace,
      policy.value.streamKeyDigest,
      input.eventKeyDigest,
    );
    if (row === undefined) return failure("store_failure");
    if (row === null) return rejectedEnvelope(operation, "event_not_found");
    if (row.receipt_state !== input.expectedReceiptState) {
      return rejectedEnvelope(operation, "receipt_state_conflict");
    }

    this.#db
      .prepare(
        `UPDATE shared_state_outbox SET receipt_state = ?
          WHERE namespace = ? AND stream_key_digest = ?
            AND event_key_digest = ?`,
      )
      .run(
        input.newReceiptState,
        input.namespace,
        policy.value.streamKeyDigest,
        input.eventKeyDigest,
      );

    return committedEnvelope(operation, {
      decision: V.operationDecisions.updateOutboxReceipt[0],
      receiptState: input.newReceiptState,
    });
  }

  /**
   * Acknowledges one confirmed event.
   *
   * The evaluator decides whether this purpose may be acknowledged at all
   * (projection evidence may not), and whether the presented evidence is
   * acknowledging evidence rather than provider acceptance. The adapter reads
   * the stored states and moves one of them.
   */
  #acknowledgeOutbox(
    input: AcknowledgeOutboxInputV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
    const operation = V.operations[9];

    const policy = evaluateSharedStateOutboxPolicyV1({
      operation,
      namespace: input.namespace,
      eventPurpose: input.eventPurpose,
      streamKey: input.streamKey,
      streamKeyDigest: input.streamKeyDigest,
      orderingScope: input.orderingScope,
      retentionPolicyVersion: input.retentionPolicyVersion,
      receiptPolicyVersion: input.receiptPolicyVersion,
      acknowledgmentPolicyVersion: input.acknowledgmentPolicyVersion,
      receiptEvidenceKind: input.receiptEvidenceKind,
      expectedReceiptState: input.expectedReceiptState,
      expectedAcknowledgmentState: input.expectedAcknowledgmentState,
    });
    if (!policy.ok) {
      // None of this operation's three rejection codes describes a refused
      // acknowledgment policy: they all describe stored row state. A
      // forbidden purpose or non-acknowledging evidence is reported as an
      // adapter failure rather than dressed as one of them.
      return failure("unregistered_outbox_registration");
    }

    const row = readOutboxByEventKey(
      this.#db,
      input.namespace,
      policy.value.streamKeyDigest,
      input.eventKeyDigest,
    );
    if (row === undefined) return failure("store_failure");
    if (row === null) return rejectedEnvelope(operation, "event_not_found");

    // A duplicate acknowledgment is answered before the expected state is
    // compared. The policy forces `expectedAcknowledgmentState` to
    // `unacknowledged`, so a retry of an accepted command necessarily
    // disagrees with the stored state; calling that a conflict would refuse
    // the retry the idempotent answer exists for.
    if (row.acknowledgment_state === V.acknowledgmentStates[1]) {
      return committedEnvelope(operation, {
        decision: V.operationDecisions.acknowledgeOutbox[1],
        acknowledgmentState: V.acknowledgmentStates[1],
      });
    }
    if (row.receipt_state !== V.receiptStates[1]) {
      return rejectedEnvelope(operation, "receipt_not_confirmed");
    }
    if (row.acknowledgment_state !== input.expectedAcknowledgmentState) {
      return rejectedEnvelope(operation, "ack_state_conflict");
    }

    this.#db
      .prepare(
        `UPDATE shared_state_outbox SET acknowledgment_state = ?
          WHERE namespace = ? AND stream_key_digest = ?
            AND event_key_digest = ?`,
      )
      .run(
        V.acknowledgmentStates[1],
        input.namespace,
        policy.value.streamKeyDigest,
        input.eventKeyDigest,
      );

    return committedEnvelope(operation, {
      decision: V.operationDecisions.acknowledgeOutbox[0],
      acknowledgmentState: V.acknowledgmentStates[1],
    });
  }

  /**
   * Appends an immutable source fact.
   *
   * A fact already recorded is replayed before its expected sequence is
   * considered at all. A retrying producer necessarily holds a stale sequence
   * — the first attempt advanced it — so checking the sequence first would
   * answer `source_sequence_conflict` to a caller whose fact is already
   * durably recorded, which describes the wrong problem.
   */
  #appendGraphSource(
    input: AppendGraphSourceInputV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
    const operation = V.operations[10];

    const existing = this.#db
      .prepare(
        `SELECT source_sequence FROM shared_state_graph_source
          WHERE namespace = ? AND source_fact_digest = ?`,
      )
      .get(input.namespace, input.sourceFactDigest) as
      | { source_sequence?: unknown }
      | undefined;
    if (existing !== undefined) {
      if (typeof existing.source_sequence !== "string") {
        return failure("store_failure");
      }
      return committedEnvelope(operation, {
        decision: V.operationDecisions.appendGraphSource[1],
        sourceSequence: existing.source_sequence,
      });
    }

    const highWater = this.#graphSourceHighWater(input.namespace);
    if (highWater === null) return failure("store_failure");
    if (BigInt(input.expectedSourceSequence) !== highWater) {
      return rejectedEnvelope(operation, "source_sequence_conflict");
    }

    const sourceSequence = (highWater + 1n).toString();
    this.#db
      .prepare(
        `INSERT INTO shared_state_graph_source
           (namespace, source_fact_digest, source_stream_key_digest,
            node_type, source_sequence)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.namespace,
        input.sourceFactDigest,
        input.sourceStreamKeyDigest,
        input.nodeType,
        sourceSequence,
      );
    return committedEnvelope(operation, {
      decision: V.operationDecisions.appendGraphSource[0],
      sourceSequence,
    });
  }

  /**
   * The greatest source sequence recorded in a namespace, or zero.
   */
  #graphSourceHighWater(namespace: string): bigint | null {
    const rows = this.#db
      .prepare(
        `SELECT source_sequence FROM shared_state_graph_source
          WHERE namespace = ?`,
      )
      .all(namespace) as readonly { source_sequence?: unknown }[];
    let high = 0n;
    for (const row of rows) {
      if (typeof row.source_sequence !== "string") return null;
      const value = BigInt(row.source_sequence);
      if (value > high) high = value;
    }
    return high;
  }

  #graphCheckpoint(
    namespace: string,
    projectionVersion: string,
  ): bigint | null | undefined {
    const row = this.#db
      .prepare(
        `SELECT checkpoint_sequence FROM shared_state_graph_projection
          WHERE namespace = ? AND projection_version = ?`,
      )
      .get(namespace, projectionVersion) as
      | { checkpoint_sequence?: unknown }
      | undefined;
    if (row === undefined) return null;
    if (typeof row.checkpoint_sequence !== "string") return undefined;
    return BigInt(row.checkpoint_sequence);
  }

  #writeGraphCheckpoint(
    namespace: string,
    projectionVersion: string,
    checkpointSequence: string,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO shared_state_graph_projection
           (namespace, projection_version, checkpoint_sequence)
         VALUES (?, ?, ?)
         ON CONFLICT(namespace, projection_version) DO UPDATE SET
           checkpoint_sequence = excluded.checkpoint_sequence`,
      )
      .run(namespace, projectionVersion, checkpointSequence);
  }

  #graphBatch(
    namespace: string,
    projectionVersion: string,
    batchKeyDigest: string,
  ): { from: bigint; through: bigint; prior: bigint; rolledBack: boolean }
    | null
    | undefined {
    const row = this.#db
      .prepare(
        `SELECT source_sequence_from, source_sequence_through,
                prior_checkpoint_sequence, rolled_back
           FROM shared_state_graph_batch
          WHERE namespace = ? AND projection_version = ?
            AND batch_key_digest = ?`,
      )
      .get(namespace, projectionVersion, batchKeyDigest) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    if (
      typeof row.source_sequence_from !== "string"
      || typeof row.source_sequence_through !== "string"
      || typeof row.prior_checkpoint_sequence !== "string"
      || typeof row.rolled_back !== "number"
    ) {
      return undefined;
    }
    return {
      from: BigInt(row.source_sequence_from),
      through: BigInt(row.source_sequence_through),
      prior: BigInt(row.prior_checkpoint_sequence),
      rolledBack: row.rolled_back !== 0,
    };
  }

  /**
   * Applies a projection batch and advances the checkpoint to the last source
   * sequence the batch consumed.
   *
   * Nodes and edges are not stored. They are exactly derivable from the
   * `[from, through]` range of every batch that has not been rolled back — one
   * node per sequence in the range and one edge from the first sequence to
   * each later one — so materializing them would duplicate the batch rows
   * rather than record anything new. Rollback removes a batch's effects rather
   * than tombstoning them, so no tombstone state exists to keep either.
   *
   * A batch already recorded is replayed, including one that has been rolled
   * back: reapplying must not resurrect the effects its inverse removed.
   */
  #applyGraphProjectionBatch(
    input: ApplyGraphProjectionBatchInputV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
    const operation = V.operations[11];
    const checkpoint = this.#graphCheckpoint(
      input.namespace,
      input.projectionVersion,
    );
    if (checkpoint === undefined) return failure("store_failure");
    const current = checkpoint ?? 0n;

    const existing = this.#graphBatch(
      input.namespace,
      input.projectionVersion,
      input.batchKeyDigest,
    );
    if (existing === undefined) return failure("store_failure");
    if (existing !== null) {
      return committedEnvelope(operation, {
        decision: V.operationDecisions.applyGraphProjectionBatch[1],
        checkpointSequence: current.toString(),
      });
    }

    const from = BigInt(input.sourceSequenceFrom);
    const through = BigInt(input.sourceSequenceThrough);
    const highWater = this.#graphSourceHighWater(input.namespace);
    if (highWater === null) return failure("store_failure");
    // A batch may only project source facts that are already durable.
    if (through > highWater || from > through) {
      return rejectedEnvelope(operation, "source_range_incomplete");
    }
    if (BigInt(input.expectedCheckpointSequence) !== current) {
      return rejectedEnvelope(operation, "checkpoint_conflict");
    }

    this.#db
      .prepare(
        `INSERT INTO shared_state_graph_batch
           (namespace, projection_version, batch_key_digest, inverse_digest,
            source_sequence_from, source_sequence_through,
            prior_checkpoint_sequence, rolled_back)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        input.namespace,
        input.projectionVersion,
        input.batchKeyDigest,
        input.inverseDigest,
        input.sourceSequenceFrom,
        input.sourceSequenceThrough,
        input.expectedCheckpointSequence,
      );
    this.#writeGraphCheckpoint(
      input.namespace,
      input.projectionVersion,
      through.toString(),
    );
    return committedEnvelope(operation, {
      decision: V.operationDecisions.applyGraphProjectionBatch[0],
      checkpointSequence: through.toString(),
    });
  }

  /**
   * Rolls a projection batch back to the checkpoint it was applied over.
   *
   * The checkpoint returns to the batch's recorded prior value rather than
   * being decremented, so a rollback undoes exactly the batch it names.
   * Source facts are never touched: they are immutable, and a projection
   * being wrong does not make the facts it read wrong.
   *
   * A batch already rolled back is replayed regardless of which rollback key
   * asks. The stored shape records that a batch was rolled back but not the
   * rollback keys that did it, so the adapter cannot tell a repeat of the same
   * rollback from a different one. Replaying is the narrower of the two
   * answers — it never re-runs an inverse — and the Phase 2.7 harness only
   * ever issues one rollback key per batch, so it does not separate them.
   * Recording rollback keys would need a column this shape does not have.
   */
  #rollbackGraphProjectionBatch(
    input: RollbackGraphProjectionBatchInputV1,
  ): SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1> {
    const operation = V.operations[12];
    const checkpoint = this.#graphCheckpoint(
      input.namespace,
      input.projectionVersion,
    );
    if (checkpoint === undefined) return failure("store_failure");
    const current = checkpoint ?? 0n;

    const batch = this.#graphBatch(
      input.namespace,
      input.projectionVersion,
      input.batchKeyDigest,
    );
    if (batch === undefined) return failure("store_failure");
    if (batch === null) {
      return rejectedEnvelope(operation, "projection_batch_not_found");
    }
    if (batch.rolledBack) {
      return committedEnvelope(operation, {
        decision: V.operationDecisions.rollbackGraphProjectionBatch[1],
        checkpointSequence: current.toString(),
      });
    }
    if (BigInt(input.expectedCheckpointSequence) !== current) {
      return rejectedEnvelope(operation, "checkpoint_conflict");
    }

    this.#db
      .prepare(
        `UPDATE shared_state_graph_batch SET rolled_back = 1
          WHERE namespace = ? AND projection_version = ?
            AND batch_key_digest = ?`,
      )
      .run(input.namespace, input.projectionVersion, input.batchKeyDigest);
    this.#writeGraphCheckpoint(
      input.namespace,
      input.projectionVersion,
      batch.prior.toString(),
    );
    return committedEnvelope(operation, {
      decision: V.operationDecisions.rollbackGraphProjectionBatch[0],
      checkpointSequence: batch.prior.toString(),
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
