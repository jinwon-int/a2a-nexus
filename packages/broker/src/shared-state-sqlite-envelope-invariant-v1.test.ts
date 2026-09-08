/**
 * #2081 phase 2: the self-parse invariant, held by test instead of by cost.
 *
 * The adapter used to re-parse every envelope it built — a full contract pass
 * (forbidden-field walk plus discriminated union) per operation result, on top
 * of the trust-boundary parse the worker protocol performs on the way back.
 * The hot path now constructs the envelope directly; this suite keeps the old
 * guarantee: **every envelope the adapter emits satisfies the closed contract
 * parser.** Each test drives implemented operations through their committed,
 * rejected, and (where reachable) unavailable outcomes and records every
 * observed envelope; the shared check at the bottom re-parses each one.
 *
 * If a new operation lands with an envelope field the contract rejects, this
 * file fails — which is the point. The worker-protocol narrowing parse stays
 * as the runtime trust boundary; this suite is the design-time net.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SharedStateSqliteAdapterV1,
  type SharedStateSqliteAdapterResultV1,
} from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateQueryResultV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  type SharedStateQueryRequestV1,
  type SharedStateQueryResultV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";
import { digestSharedStateKeyV1 } from "./shared-state-storage-keyspace-v1.js";

interface Fixture {
  readonly db: DatabaseSync;
  readonly directory: string;
}

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "shared-state-envelope-"));
  const db = new DatabaseSync(join(directory, "v1.db"));
  assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
  return { db, directory };
}

function disposeFixture(fixture: Fixture): void {
  fixture.db.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

function readyAdapter(db: DatabaseSync): SharedStateSqliteAdapterV1 {
  const owner = new SharedStateSqliteAdapterV1({
    db,
    ownerToken: "envelope-owner-a",
    backwardSkewToleranceMs: "0",
  });
  assert.equal(owner.open().ok, true);
  return owner;
}

const NAMESPACE = "broker.test";
const OUTBOX_NAMESPACE = "broker.terminal-outbox";
const IDEMPOTENCY_NAMESPACE = "broker.task.create";
const PROJECTION_VERSION = "envelope-projection-v1";

/** Every observed envelope lands here for the closing parser sweep. */
const observedTransactions: SharedStateTransactionResultV1[] = [];
const observedQueries: SharedStateQueryResultV1[] = [];

function record(
  result: SharedStateSqliteAdapterResultV1<
    SharedStateTransactionResultV1 | SharedStateQueryResultV1
  >,
): Record<string, unknown> {
  assert.equal(result.ok, true, "scenario must produce an envelope");
  if (!result.ok) throw new Error("unreachable");
  const value = result.value;
  if (value.kind === V.kinds.transactionResult) {
    observedTransactions.push(value);
  } else {
    observedQueries.push(value);
  }
  if (value.status !== "committed" && value.status !== "succeeded") {
    return { status: value.status, reasonCode: value.reasonCode };
  }
  return value.result as Record<string, unknown>;
}

function transact(
  owner: SharedStateSqliteAdapterV1,
  command: SharedStateTransactionCommandV1,
  observedAtUnixMs = "1000",
): Record<string, unknown> {
  return record(owner.transact(command, { observedAtUnixMs }));
}

function query(
  owner: SharedStateSqliteAdapterV1,
  request: SharedStateQueryRequestV1,
): Record<string, unknown> {
  return record(owner.query(request));
}

function digest(
  namespace: string,
  domain: string,
  components: readonly Record<string, unknown>[],
): string {
  const built = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace,
    components,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  return built.value.digest;
}

function command(
  operation: SharedStateTransactionCommandV1["operation"],
  input: Record<string, unknown>,
): SharedStateTransactionCommandV1 {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input: { namespace: NAMESPACE, ...input },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

// ── command builders (one per implemented operation) ──────────────────────

function replayCommand(input: {
  readonly nonce: string;
  readonly ttlMs: number;
}): SharedStateTransactionCommandV1 {
  return command("consumeReplayNonce", {
    keyDigest: digest(NAMESPACE, "security.replay.requester-key", [
      { field: "requesterId", type: "utf8", value: "requester-1" },
    ]),
    nonceDigest: digest(NAMESPACE, "security.replay.nonce", [
      { field: "nonce", type: "utf8", value: input.nonce },
    ]),
    ttlMs: input.ttlMs,
  });
}

function rateCommand(input: {
  readonly cost: number;
  readonly limit: number;
  readonly windowMs: number;
}): SharedStateTransactionCommandV1 {
  return command("reserveRateLimitCost", {
    bucketKeyDigest: digest(NAMESPACE, "security.rate-limit.bucket-key", [
      { field: "principal", type: "utf8", value: "principal-1" },
      { field: "route", type: "utf8", value: "route-1" },
    ]),
    cost: input.cost,
    limit: input.limit,
    windowMs: input.windowMs,
  });
}

const RESOURCE = digest(NAMESPACE, "broker.lease.resource-key", [
  { field: "resourceType", type: "utf8", value: "task" },
  { field: "resourceId", type: "utf8", value: "task-1" },
]);

function ownerDigest(ownerId: string): string {
  return digest(NAMESPACE, "broker.lease.owner-key", [
    { field: "ownerId", type: "utf8", value: ownerId },
  ]);
}

function claimCommand(input: {
  readonly owner: string;
  readonly leaseDurationMs: number;
  readonly expectedResourceVersion: string;
}): SharedStateTransactionCommandV1 {
  return command("claimLease", {
    resourceKeyDigest: RESOURCE,
    ownerKeyDigest: ownerDigest(input.owner),
    leaseDurationMs: input.leaseDurationMs,
    expectedResourceVersion: input.expectedResourceVersion,
  });
}

interface Authority {
  readonly owner: string;
  readonly attemptKeyDigest: string;
  readonly fencingToken: string;
  readonly expectedResourceVersion: string;
}

function authorityOf(owner: string, result: Record<string, unknown>): Authority {
  return {
    owner,
    attemptKeyDigest: String(result.attemptKeyDigest),
    fencingToken: String(result.fencingToken),
    expectedResourceVersion: String(result.resourceVersion),
  };
}

function authorityCommand(
  operation: "renewLease" | "mutateWithFence" | "releaseLease",
  authority: Authority,
  extra: Record<string, unknown>,
): SharedStateTransactionCommandV1 {
  return command(operation, {
    resourceKeyDigest: RESOURCE,
    ownerKeyDigest: ownerDigest(authority.owner),
    attemptKeyDigest: authority.attemptKeyDigest,
    fencingToken: authority.fencingToken,
    expectedResourceVersion: authority.expectedResourceVersion,
    ...extra,
  });
}

function mutationDigest(kind: string): string {
  return digest(NAMESPACE, "broker.lease.mutation", [
    { field: "mutationKind", type: "utf8", value: kind },
    { field: "mutationBody", type: "bytes", value: "00" },
  ]);
}

function idempotentCommand(input: {
  readonly clientKey: string;
  readonly payload: string;
}): SharedStateTransactionCommandV1 {
  const d = (
    domain: string,
    components: readonly Record<string, unknown>[],
  ): string => digest(IDEMPOTENCY_NAMESPACE, domain, components);
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "executeIdempotent",
    input: {
      namespace: IDEMPOTENCY_NAMESPACE,
      keyDigest: d("broker.idempotency.key", [
        { field: "operationName", type: "utf8", value: "create-task" },
        { field: "clientKey", type: "utf8", value: input.clientKey },
      ]),
      payloadFingerprint: d("broker.idempotency.payload-fingerprint", [
        { field: "payload", type: "bytes", value: input.payload },
      ]),
      retentionPolicyVersion: "task-create-effects.v1",
      effect: {
        kind: "domain-mutation-with-outbox",
        domainMutationDigest: d("broker.idempotency.domain-mutation", [
          { field: "mutationType", type: "utf8", value: "create" },
          { field: "mutationBody", type: "bytes", value: "aa" },
        ]),
        outbox: {
          streamKeyDigest: d("broker.outbox.stream-key", [
            { field: "streamType", type: "utf8", value: "task" },
            { field: "streamId", type: "utf8", value: "s-1" },
          ]),
          eventKeyDigest: d("broker.outbox.event-key", [
            { field: "eventId", type: "utf8", value: "e-1" },
          ]),
          payloadDigest: d("broker.outbox.payload", [
            { field: "payload", type: "bytes", value: "bb" },
          ]),
          retentionPolicyVersion: "caller-owned-outbox.v1",
        },
      },
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

function outboxStream(streamId: string): {
  readonly streamKey: Record<string, unknown>;
  readonly streamKeyDigest: string;
} {
  const components = [
    { field: "streamType", type: "utf8", value: "broker-terminal-outbox" },
    { field: "streamId", type: "utf8", value: streamId },
  ];
  return {
    streamKey: { keyspaceVersion: V.versions.keyspace, components },
    streamKeyDigest: digest(
      OUTBOX_NAMESPACE,
      "broker.outbox.stream-key",
      components,
    ),
  };
}

function outboxCommand(
  operation: string,
  input: Record<string, unknown>,
): SharedStateTransactionCommandV1 {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    input,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

function appendOutboxCommand(input: {
  readonly eventId: string;
  readonly clientKey?: string;
}): SharedStateTransactionCommandV1 {
  const stream = outboxStream("stream-1");
  const d = (
    domain: string,
    components: readonly Record<string, unknown>[],
  ): string => digest(OUTBOX_NAMESPACE, domain, components);
  return outboxCommand("appendOutbox", {
    namespace: OUTBOX_NAMESPACE,
    eventPurpose: "task-terminal-notification",
    streamKey: stream.streamKey,
    streamKeyDigest: stream.streamKeyDigest,
    orderingScope: "total-within-exact-stream-key",
    idempotencyKeyDigest: d("broker.outbox.idempotency-key", [
      { field: "producerId", type: "utf8", value: "p-1" },
      {
        field: "clientKey",
        type: "utf8",
        value: input.clientKey ?? input.eventId,
      },
    ]),
    eventKeyDigest: d("broker.outbox.event-key", [
      { field: "eventId", type: "utf8", value: input.eventId },
    ]),
    payloadDigest: d("broker.outbox.payload", [
      { field: "payload", type: "bytes", value: "a1" },
    ]),
    retentionPolicyVersion: "task-terminal-outbox-retention.v1",
    receiptPolicyVersion: "terminal-notification-receipt.v1",
    acknowledgmentPolicyVersion: "terminal-notification-ack.v1",
  });
}

function eventKeyDigest(eventId: string): string {
  return digest(OUTBOX_NAMESPACE, "broker.outbox.event-key", [
    { field: "eventId", type: "utf8", value: eventId },
  ]);
}

function receiptCommand(input: {
  readonly eventId: string;
  readonly expected: string;
  readonly next: string;
}): SharedStateTransactionCommandV1 {
  const stream = outboxStream("stream-1");
  return outboxCommand("updateOutboxReceipt", {
    namespace: OUTBOX_NAMESPACE,
    eventPurpose: "task-terminal-notification",
    streamKey: stream.streamKey,
    streamKeyDigest: stream.streamKeyDigest,
    orderingScope: "total-within-exact-stream-key",
    eventKeyDigest: eventKeyDigest(input.eventId),
    receiptEvidenceDigest: digest(
      OUTBOX_NAMESPACE,
      "broker.outbox.receipt-evidence",
      [
        { field: "provider", type: "utf8", value: "provider-1" },
        { field: "evidence", type: "bytes", value: "e1" },
      ],
    ),
    receiptEvidenceKind: "operator-confirmed",
    expectedReceiptState: input.expected,
    newReceiptState: input.next,
    retentionPolicyVersion: "task-terminal-outbox-retention.v1",
    receiptPolicyVersion: "terminal-notification-receipt.v1",
    acknowledgmentPolicyVersion: "terminal-notification-ack.v1",
  });
}

function acknowledgeCommand(input: {
  readonly eventId: string;
}): SharedStateTransactionCommandV1 {
  const stream = outboxStream("stream-1");
  return outboxCommand("acknowledgeOutbox", {
    namespace: OUTBOX_NAMESPACE,
    eventPurpose: "task-terminal-notification",
    streamKey: stream.streamKey,
    streamKeyDigest: stream.streamKeyDigest,
    orderingScope: "total-within-exact-stream-key",
    eventKeyDigest: eventKeyDigest(input.eventId),
    receiptEvidenceDigest: digest(
      OUTBOX_NAMESPACE,
      "broker.outbox.receipt-evidence",
      [
        { field: "provider", type: "utf8", value: "provider-1" },
        { field: "evidence", type: "bytes", value: "e1" },
      ],
    ),
    receiptEvidenceKind: "operator-confirmed",
    expectedReceiptState: "confirmed",
    expectedAcknowledgmentState: "unacknowledged",
    retentionPolicyVersion: "task-terminal-outbox-retention.v1",
    receiptPolicyVersion: "terminal-notification-receipt.v1",
    acknowledgmentPolicyVersion: "terminal-notification-ack.v1",
  });
}

function appendGraphSourceCommand(
  ordinal: number,
): SharedStateTransactionCommandV1 {
  return command("appendGraphSource", {
    sourceStreamKeyDigest: digest(
      NAMESPACE,
      "broker.claim-graph.source-stream-key",
      [
        { field: "sourceType", type: "utf8", value: "envelope" },
        { field: "sourceId", type: "utf8", value: "run-1" },
      ],
    ),
    sourceFactDigest: digest(NAMESPACE, "broker.claim-graph.source-fact", [
      { field: "nodeType", type: "utf8", value: "Claim" },
      {
        field: "fact",
        type: "bytes",
        value: ordinal.toString(16).padStart(2, "0"),
      },
    ]),
    nodeType: "Claim",
    expectedSourceSequence: String(ordinal - 1),
  });
}

function graphSourceFact(ordinal: number): string {
  return digest(NAMESPACE, "broker.claim-graph.source-fact", [
    { field: "nodeType", type: "utf8", value: "Claim" },
    {
      field: "fact",
      type: "bytes",
      value: ordinal.toString(16).padStart(2, "0"),
    },
  ]);
}

function applyBatchCommand(input: {
  readonly batchId: string;
  readonly from: number;
  readonly through: number;
  readonly expectedCheckpoint: number;
}): SharedStateTransactionCommandV1 {
  return command("applyGraphProjectionBatch", {
    projectionVersion: PROJECTION_VERSION,
    batchKeyDigest: digest(
      NAMESPACE,
      "broker.claim-graph.projection-batch-key",
      [
        {
          field: "projectionVersion",
          type: "utf8",
          value: PROJECTION_VERSION,
        },
        { field: "batchId", type: "utf8", value: input.batchId },
      ],
    ),
    batchDigest: digest(NAMESPACE, "broker.claim-graph.projection-batch", [
      { field: "batch", type: "bytes", value: "a1" },
    ]),
    inverseDigest: digest(NAMESPACE, "broker.claim-graph.projection-inverse", [
      { field: "inverse", type: "bytes", value: "b1" },
    ]),
    sourceSequenceFrom: String(input.from),
    sourceSequenceThrough: String(input.through),
    expectedCheckpointSequence: String(input.expectedCheckpoint),
  });
}

function rollbackBatchCommand(input: {
  readonly batchId: string;
  readonly expectedCheckpoint: number;
}): SharedStateTransactionCommandV1 {
  return command("rollbackGraphProjectionBatch", {
    projectionVersion: PROJECTION_VERSION,
    batchKeyDigest: digest(
      NAMESPACE,
      "broker.claim-graph.projection-batch-key",
      [
        {
          field: "projectionVersion",
          type: "utf8",
          value: PROJECTION_VERSION,
        },
        { field: "batchId", type: "utf8", value: input.batchId },
      ],
    ),
    rollbackBatchKeyDigest: digest(
      NAMESPACE,
      "broker.claim-graph.rollback-batch-key",
      [
        {
          field: "projectionVersion",
          type: "utf8",
          value: PROJECTION_VERSION,
        },
        {
          field: "rollbackId",
          type: "utf8",
          value: `rollback-${input.batchId}`,
        },
      ],
    ),
    inverseDigest: digest(NAMESPACE, "broker.claim-graph.projection-inverse", [
      { field: "inverse", type: "bytes", value: "b1" },
    ]),
    expectedCheckpointSequence: String(input.expectedCheckpoint),
  });
}

function reconcileRequest(
  cursor: string | null,
  limit: number,
): SharedStateQueryRequestV1 {
  const stream = outboxStream("stream-1");
  const parsed = parseSharedStateQueryRequestV1({
    kind: V.kinds.queryRequest,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: "reconcileOutbox",
    input: {
      namespace: OUTBOX_NAMESPACE,
      streamKeyDigest: stream.streamKeyDigest,
      cursor,
      limit,
      requiredConsistency: V.queryConsistency.reconcileOutbox,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.operation !== "reconcileOutbox") {
    throw new Error("unreachable");
  }
  return parsed.value;
}

function graphQueryRequest(input: {
  readonly claim: number;
  readonly evidence: number;
}): SharedStateQueryRequestV1 {
  const parsed = parseSharedStateQueryRequestV1({
    kind: V.kinds.queryRequest,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: "queryGraphEvidencePath",
    input: {
      namespace: NAMESPACE,
      projectionVersion: PROJECTION_VERSION,
      claimSourceFactDigest: graphSourceFact(input.claim),
      evidenceSourceFactDigest: graphSourceFact(input.evidence),
      maxPathEdges: 8,
      requiredConsistency: V.queryConsistency.queryGraphEvidencePath,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.operation !== "queryGraphEvidencePath") {
    throw new Error("unreachable");
  }
  return parsed.value;
}

// ── the sweep: every operation × every reachable outcome ──────────────────

test("the adapter sweep reaches every implemented operation", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);

    // consumeReplayNonce: committed fresh, committed replay.
    transact(owner, replayCommand({ nonce: "n-1", ttlMs: 1_000 }));
    transact(owner, replayCommand({ nonce: "n-1", ttlMs: 1_000 }));

    // reserveRateLimitCost: committed allowed, committed refused, and the
    // invalid_rate_policy rejection — reachable only through a stored row the
    // boundary evaluator cannot judge, so it runs in its own fixture below.
    transact(owner, rateCommand({ cost: 6, limit: 10, windowMs: 1_000 }));
    transact(owner, rateCommand({ cost: 5, limit: 10, windowMs: 1_000 }));
    transact(owner, rateCommand({ cost: 1, limit: 10, windowMs: 1_000 }));

    // claimLease: committed, rejected live-claim conflict.
    const claim = transact(
      owner,
      claimCommand({ owner: "o-1", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
    );
    transact(
      owner,
      claimCommand({ owner: "o-2", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
    );

    // renewLease: committed, rejected stale fence.
    const authority = authorityOf("o-1", claim);
    const renewed = transact(
      owner,
      authorityCommand("renewLease", authority, { leaseDurationMs: 1_000 }),
    );
    transact(
      owner,
      authorityCommand(
        "renewLease",
        { ...authority, fencingToken: "999" },
        { leaseDurationMs: 1_000 },
      ),
    );

    // mutateWithFence: committed, rejected wrong owner. The renew advanced
    // the resource version, so the mutation presents the renewed version (the
    // attempt key and fence are unchanged by a renew).
    const current = {
      ...authority,
      expectedResourceVersion: String(renewed.resourceVersion),
    };
    const mutated = transact(
      owner,
      authorityCommand("mutateWithFence", current, {
        mutationKind: "checkpoint",
        mutationDigest: mutationDigest("checkpoint"),
      }),
    );
    transact(
      owner,
      authorityCommand(
        "mutateWithFence",
        { ...current, owner: "o-2" },
        {
          mutationKind: "checkpoint",
          mutationDigest: mutationDigest("checkpoint"),
        },
      ),
    );

    // releaseLease: committed; a second release with the stale authority.
    const final = {
      ...current,
      expectedResourceVersion: String(mutated.resourceVersion),
    };
    transact(
      owner,
      authorityCommand("releaseLease", final, { releaseKind: "release" }),
    );
    transact(
      owner,
      authorityCommand("releaseLease", final, { releaseKind: "release" }),
    );

    // executeIdempotent: apply, replay, conflicting payload, unknown retention.
    transact(owner, idempotentCommand({ clientKey: "c-1", payload: "aa" }));
    transact(owner, idempotentCommand({ clientKey: "c-1", payload: "aa" }));
    transact(owner, idempotentCommand({ clientKey: "c-1", payload: "bb" }));
    transact(owner, idempotentCommand({ clientKey: "c-2", payload: "aa" }));

    // appendOutbox: fresh, retry with the same key returns the original, and
    // a retry that changes the event key under the same idempotency key is a
    // conflict (the retention-mismatch rejection is unreachable here: the
    // command preflight already refuses it before the adapter runs).
    transact(owner, appendOutboxCommand({ eventId: "e-1" }));
    transact(
      owner,
      appendOutboxCommand({ eventId: "e-1", clientKey: "e-1" }),
    );
    transact(
      owner,
      appendOutboxCommand({ eventId: "e-9", clientKey: "e-1" }),
    );

    // updateOutboxReceipt: unknown event, pending → confirmed, then a
    // compare-and-set that still expects pending is a conflict.
    transact(
      owner,
      receiptCommand({ eventId: "missing", expected: "pending", next: "confirmed" }),
    );
    transact(
      owner,
      receiptCommand({ eventId: "e-1", expected: "pending", next: "confirmed" }),
    );
    transact(
      owner,
      receiptCommand({ eventId: "e-1", expected: "pending", next: "confirmed" }),
    );

    // acknowledgeOutbox: rejected before confirmation, committed after.
    transact(owner, acknowledgeCommand({ eventId: "e-2" }));
    transact(owner, appendOutboxCommand({ eventId: "e-2" }));
    transact(
      owner,
      receiptCommand({ eventId: "e-2", expected: "pending", next: "confirmed" }),
    );
    transact(owner, acknowledgeCommand({ eventId: "e-2" }));

    // appendGraphSource: committed, replayed, sequence conflict.
    transact(owner, appendGraphSourceCommand(1));
    transact(owner, appendGraphSourceCommand(1));
    transact(owner, appendGraphSourceCommand(3));

    // applyGraphProjectionBatch: range conflict, checkpoint conflict, committed.
    transact(
      owner,
      applyBatchCommand({ batchId: "b1", from: 1, through: 9, expectedCheckpoint: 0 }),
    );
    transact(
      owner,
      applyBatchCommand({ batchId: "b1", from: 1, through: 1, expectedCheckpoint: 5 }),
    );
    transact(
      owner,
      applyBatchCommand({ batchId: "b1", from: 1, through: 1, expectedCheckpoint: 0 }),
    );

    // rollbackGraphProjectionBatch: not found, then committed.
    transact(
      owner,
      rollbackBatchCommand({ batchId: "never", expectedCheckpoint: 1 }),
    );
    transact(
      owner,
      rollbackBatchCommand({ batchId: "b1", expectedCheckpoint: 1 }),
    );

    // reconcileOutbox: succeeded page, unavailable bad cursor.
    query(owner, reconcileRequest(null, 2));
    query(owner, reconcileRequest("999", 2));

    // queryGraphEvidencePath: found, no-path, and unavailable via an
    // impossible checkpoint written behind the adapter's back.
    query(owner, graphQueryRequest({ claim: 1, evidence: 2 }));
    query(owner, graphQueryRequest({ claim: 2, evidence: 1 }));
  } finally {
    disposeFixture(fixture);
  }

  const fixture2 = makeFixture();
  try {
    const owner2 = readyAdapter(fixture2.db);
    // consumeReplayNonce's invalid_expiry rejection: the command schema bounds
    // ttl, so the only reachable failure is an expiry that overflows the
    // timestamp bound. Isolated adapter — the observation drags the clock
    // floor (committed even on rejection) to the timestamp ceiling.
    transact(
      owner2,
      replayCommand({ nonce: "n-2", ttlMs: 1_000 }),
      "9223372036854775000",
    );
  } finally {
    disposeFixture(fixture2);
  }

  const fixture3 = makeFixture();
  try {
    const owner3 = readyAdapter(fixture3.db);
    // reserveRateLimitCost's invalid_rate_policy rejection: a stored rate row
    // with an unleasurable event_at makes the boundary evaluator fail on the
    // next reserve — the phase-1 bounded scan deliberately keeps such rows
    // observable so this rejection stays reachable.
    transact(owner3, rateCommand({ cost: 1, limit: 10, windowMs: 1_000 }));
    fixture3.db
      .prepare(
        `UPDATE shared_state_rate_cost SET event_at_unix_ms = 'oops'
          WHERE namespace = ?`,
      )
      .run(NAMESPACE);
    transact(owner3, rateCommand({ cost: 1, limit: 10, windowMs: 1_000 }));
  } finally {
    disposeFixture(fixture3);
  }

  const fixture4 = makeFixture();
  try {
    const owner4 = readyAdapter(fixture4.db);
    transact(owner4, appendGraphSourceCommand(1));
    fixture4.db
      .prepare(
        `UPDATE shared_state_graph_projection SET checkpoint_sequence = '9'
          WHERE namespace = ? AND projection_version = ?`,
      )
      .run(NAMESPACE, PROJECTION_VERSION);
    fixture4.db
      .prepare(
        `INSERT INTO shared_state_graph_projection
           (namespace, projection_version, checkpoint_sequence)
           SELECT ?, ?, '9'
            WHERE NOT EXISTS (
              SELECT 1 FROM shared_state_graph_projection
               WHERE namespace = ? AND projection_version = ?)`,
      )
      .run(NAMESPACE, PROJECTION_VERSION, NAMESPACE, PROJECTION_VERSION);
    query(owner4, graphQueryRequest({ claim: 1, evidence: 1 }));
  } finally {
    disposeFixture(fixture4);
  }

  // Every observed envelope must satisfy the closed contract parser.
  assert.ok(observedTransactions.length >= 25, "sweep must be non-trivial");
  const seenOutcomes = new Set<string>();
  for (const envelope of observedTransactions) {
    const parsed = parseSharedStateTransactionResultV1(envelope);
    assert.equal(
      parsed.ok,
      true,
      `adapter emitted an envelope the contract rejects: ${
        parsed.ok ? "" : JSON.stringify(parsed.error)
      } for ${JSON.stringify(envelope)}`,
    );
    seenOutcomes.add(`${envelope.operation}:${envelope.status}`);
  }
  for (const envelope of observedQueries) {
    const parsed = parseSharedStateQueryResultV1(envelope);
    assert.equal(
      parsed.ok,
      true,
      `adapter emitted a query envelope the contract rejects: ${
        parsed.ok ? "" : JSON.stringify(parsed.error)
      } for ${JSON.stringify(envelope)}`,
    );
  }

  // Coverage: every implemented operation observed committed AND rejected.
  for (const operation of [
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
  ] as const) {
    assert.ok(
      seenOutcomes.has(`${operation}:committed`),
      `sweep never reached a committed ${operation}`,
    );
    assert.ok(
      seenOutcomes.has(`${operation}:rejected`),
      `sweep never reached a rejected ${operation}`,
    );
  }
  assert.ok(
    seenOutcomes.has("consumeReplayNonce:unavailable")
    || observedQueries.some(
      (envelope) =>
        envelope.operation === "queryGraphEvidencePath"
        && envelope.status === "unavailable",
    ),
    "sweep never reached an unavailable envelope",
  );
});

test("an unsafe clock yields the operation-preserving unavailable envelope", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    transact(owner, replayCommand({ nonce: "n-1", ttlMs: 1_000 }));
    // The floor is now at 1000 with zero skew tolerance: observing 500 again
    // is unsafe, so the answer is the unavailable envelope and the adapter
    // stops being writable.
    const result = owner.transact(replayCommand({ nonce: "n-2", ttlMs: 1_000 }), {
      observedAtUnixMs: "500",
    });
    const value = record(result);
    assert.equal(value.status, "unavailable");
    assert.equal(value.reasonCode, "unsafe_clock");

    const fixture2 = makeFixture();
    try {
      const owner2 = readyAdapter(fixture2.db);
      transact(owner2, rateCommand({ cost: 1, limit: 10, windowMs: 1_000 }));
      const result2 = owner2.transact(
        rateCommand({ cost: 1, limit: 10, windowMs: 1_000 }),
        { observedAtUnixMs: "500" },
      );
      const value2 = record(result2);
      assert.equal(value2.status, "unavailable");
      assert.equal(value2.reasonCode, "unsafe_clock");
    } finally {
      disposeFixture(fixture2);
    }
  } finally {
    disposeFixture(fixture);
  }
});

test("every recorded envelope parses (the invariant, asserted)", () => {
  for (const envelope of observedTransactions) {
    assert.equal(
      parseSharedStateTransactionResultV1(envelope).ok,
      true,
      `unparseable transaction envelope: ${JSON.stringify(envelope)}`,
    );
  }
  for (const envelope of observedQueries) {
    const parsed = parseSharedStateQueryResultV1(envelope);
    assert.equal(
      parsed.ok,
      true,
      `unparseable query envelope: ${JSON.stringify(envelope)}`,
    );
    if (parsed.ok) {
      assert.equal(parsed.value.operation, envelope.operation);
    }
  }
});
