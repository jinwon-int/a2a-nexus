/**
 * TEST-ONLY W1 proof for the bounded FIFO worker lane in front of the V1
 * SQLite adapter.
 *
 * WHAT THIS SLICE PROVES THAT NO EARLIER ONE DID
 * Every earlier target drove `SharedStateSqliteAdapterV1` inline, on the
 * thread that owned it. This one proves the worker-mode seam decision W0
 * authorized: a purpose-built closed protocol, one bounded FIFO lane, tickets
 * assigned only after a successful parse and an available slot, transaction
 * results that follow SQLite `COMMIT` and a matching worker acknowledgment,
 * queries serialized behind every earlier accepted command, and fail-closed
 * behaviour for ambiguity, worker loss, drain timeout, and unclean close.
 *
 * Two harness levels appear here on purpose.
 *   - A substitute channel drives the lane deterministically. Timeouts,
 *     crossed responses, and worker loss are not reliably reproducible against
 *     a real thread, and a flaky proof of a fail-closed rule is worse than no
 *     proof.
 *   - A real `node:worker_threads` thread drives the end-to-end path, because
 *     COMMIT-before-ACK and the two query families are exactly the claims a
 *     substitute channel could fake.
 *
 * What this does NOT do: it checks neither 488 nor 489. It runs no V1
 * deterministic conformance suite through worker mode, and it proves no
 * worker-backed read consistency beyond the single-lane barrier asserted here.
 * It adds no broker runtime, HTTP, configuration flag, default, serving-store
 * selection, retention, migration, or performance claim, and it neither
 * imports nor modifies the legacy `core/sqlite-worker-thread-persistence.ts`
 * lane.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createSharedStateSqliteWorkerThreadChannelV1 } from "./shared-state-sqlite-worker-channel-v1.js";
import {
  SHARED_STATE_SQLITE_WORKER_LANE_V1,
  createSharedStateSqliteWorkerLaneV1,
  type SharedStateSqliteWorkerChannelHandlersV1,
  type SharedStateSqliteWorkerLaneV1,
} from "./shared-state-sqlite-worker-lane-v1.js";
import {
  SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1,
  buildSharedStateSqliteWorkerRequestV1,
  buildSharedStateSqliteWorkerValueResponseV1,
  parseSharedStateSqliteWorkerRequestV1,
  parseSharedStateSqliteWorkerResponseV1,
  type SharedStateSqliteWorkerRequestV1,
} from "./shared-state-sqlite-worker-protocol-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateTransactionCommandV1,
  type SharedStateQueryRequestV1,
  type SharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";
import { digestSharedStateKeyV1 } from "./shared-state-storage-keyspace-v1.js";

const LEASE_NAMESPACE = "broker.lease.worker-lane";
const OUTBOX_NAMESPACE = "broker.terminal-outbox";
const GRAPH_NAMESPACE = "broker.claim-graph.worker-lane";
const SKEW_TOLERANCE_MS = "0";

/**
 * The lane is a scheduling seam, so it must expose exactly these members and no
 * adapter internals. Asserted below so a later slice cannot quietly widen the
 * worker surface into a full-adapter claim.
 */
const LANE_PUBLIC_MEMBERS_V1 = Object.freeze([
  "close",
  "diagnostics",
  "drain",
  "open",
  "query",
  "terminate",
  "transact",
] as const);

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

function transactionCommand(
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

/** A lease claim: the cheapest command that also yields a domain rejection. */
function claimCommand(input: {
  readonly owner: string;
  readonly expectedResourceVersion: string;
  readonly resourceId?: string;
}): SharedStateTransactionCommandV1 {
  return transactionCommand("claimLease", {
    namespace: LEASE_NAMESPACE,
    resourceKeyDigest: digest(LEASE_NAMESPACE, "broker.lease.resource-key", [
      { field: "resourceType", type: "utf8", value: "worker-lane" },
      {
        field: "resourceId",
        type: "utf8",
        value: input.resourceId ?? "lane-resource",
      },
    ]),
    ownerKeyDigest: digest(LEASE_NAMESPACE, "broker.lease.owner-key", [
      { field: "ownerId", type: "utf8", value: input.owner },
    ]),
    leaseDurationMs: 60_000,
    expectedResourceVersion: input.expectedResourceVersion,
  });
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

function appendOutboxCommand(input: {
  readonly streamId: string;
  readonly eventId: string;
}): SharedStateTransactionCommandV1 {
  const stream = outboxStream(input.streamId);
  const d = (
    domain: string,
    components: readonly Record<string, unknown>[],
  ): string => digest(OUTBOX_NAMESPACE, domain, components);
  return transactionCommand("appendOutbox", {
    namespace: OUTBOX_NAMESPACE,
    eventPurpose: "task-terminal-notification",
    streamKey: stream.streamKey,
    streamKeyDigest: stream.streamKeyDigest,
    orderingScope: "total-within-exact-stream-key",
    idempotencyKeyDigest: d("broker.outbox.idempotency-key", [
      { field: "producerId", type: "utf8", value: "worker-lane" },
      { field: "clientKey", type: "utf8", value: input.eventId },
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

function reconcileOutboxRequest(streamId: string): SharedStateQueryRequestV1 {
  const parsed = parseSharedStateQueryRequestV1({
    kind: V.kinds.queryRequest,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: "reconcileOutbox",
    input: {
      namespace: OUTBOX_NAMESPACE,
      streamKeyDigest: outboxStream(streamId).streamKeyDigest,
      cursor: null,
      limit: 10,
      requiredConsistency: V.queryConsistency.reconcileOutbox,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

function graphEvidenceRequest(): SharedStateQueryRequestV1 {
  const factDigest = (fact: string): string =>
    digest(GRAPH_NAMESPACE, "broker.claim-graph.source-fact", [
      { field: "nodeType", type: "utf8", value: "Claim" },
      { field: "fact", type: "bytes", value: fact },
    ]);
  const parsed = parseSharedStateQueryRequestV1({
    kind: V.kinds.queryRequest,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: "queryGraphEvidencePath",
    input: {
      namespace: GRAPH_NAMESPACE,
      projectionVersion: "worker-lane-projection-v1",
      claimSourceFactDigest: factDigest("a1"),
      evidenceSourceFactDigest: factDigest("b2"),
      maxPathEdges: 8,
      requiredConsistency: V.queryConsistency.queryGraphEvidencePath,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

/**
 * A substitute channel. It records what the lane posted and lets a test decide
 * exactly when — and whether — a response crosses back.
 */
function createScriptedChannelV1() {
  const posted: SharedStateSqliteWorkerRequestV1[] = [];
  let handlers: SharedStateSqliteWorkerChannelHandlersV1 | null = null;
  let terminations = 0;

  return {
    posted,
    get terminations(): number {
      return terminations;
    },
    factory: (
      input: SharedStateSqliteWorkerChannelHandlersV1,
    ): {
      post(request: SharedStateSqliteWorkerRequestV1): void;
      terminate(): Promise<void>;
    } => {
      handlers = input;
      return {
        post(request: SharedStateSqliteWorkerRequestV1): void {
          posted.push(request);
        },
        async terminate(): Promise<void> {
          terminations += 1;
        },
      };
    },
    /** Answers the most recently posted request with an arbitrary message. */
    deliver(message: unknown): void {
      assert.notEqual(handlers, null);
      handlers?.onMessage(message);
    },
    respondValue(index: number, value: unknown): void {
      const request = posted[index];
      assert.notEqual(request, undefined);
      if (!request) throw new Error("unreachable");
      this.deliver(
        buildSharedStateSqliteWorkerValueResponseV1(
          request.ticket,
          request.command,
          value,
        ),
      );
    },
    lose(reason: "worker_error" | "worker_exit"): void {
      assert.notEqual(handlers, null);
      handlers?.onLoss(reason);
    },
  };
}

function lifecycleValue(state: string): Record<string, unknown> {
  return {
    kind: V.kinds.lifecycle,
    lifecycleVersion: V.versions.lifecycle,
    contractVersion: V.versions.contract,
    state,
    reasonCodes: [],
  };
}

/**
 * Waits until the lane has posted at least `count` requests. `drain` and
 * `close` reach their admission step only after an internal await, so a test
 * cannot assume the request is already on the wire when the call returns.
 */
async function waitForPostCountV1(
  channel: ReturnType<typeof createScriptedChannelV1>,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (channel.posted.length >= count) return;
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(`worker lane never posted ${count} request(s)`);
}

/** Opens a lane over the substitute channel and answers its `open` ticket. */
async function openScriptedLaneV1(
  channel: ReturnType<typeof createScriptedChannelV1>,
  options: { queueCapacity: number; acknowledgmentTimeoutMs?: number },
): Promise<SharedStateSqliteWorkerLaneV1> {
  const lane = createSharedStateSqliteWorkerLaneV1({
    channel: channel.factory,
    queueCapacity: options.queueCapacity,
    acknowledgmentTimeoutMs: options.acknowledgmentTimeoutMs ?? 0,
    drainTimeoutMs: 50,
  });
  const opening = lane.open();
  channel.respondValue(0, lifecycleValue("ready"));
  const opened = await opening;
  assert.equal(opened.ok, true);
  return lane;
}

// ---------------------------------------------------------------------------
// Boundary declarations
// ---------------------------------------------------------------------------

test("declares the W1 lane boundary and its closed protocol surface", () => {
  assert.equal(
    SHARED_STATE_SQLITE_WORKER_LANE_V1.serialization,
    "single-bounded-fifo",
  );
  assert.equal(
    SHARED_STATE_SQLITE_WORKER_LANE_V1.commitAcknowledgment,
    "commit-before-ack",
  );
  assert.equal(
    SHARED_STATE_SQLITE_WORKER_LANE_V1.ticketScope,
    "process-local-scheduling-evidence",
  );
  // The three claims W0 forbids this slice from making.
  assert.equal(
    SHARED_STATE_SQLITE_WORKER_LANE_V1.fullAdapterConformanceClaimed,
    false,
  );
  assert.equal(
    SHARED_STATE_SQLITE_WORKER_LANE_V1.attachedToBrokerRuntime,
    false,
  );
  assert.equal(
    SHARED_STATE_SQLITE_WORKER_LANE_V1.reusesLegacyPersistenceWorker,
    false,
  );
  assert.equal(
    SHARED_STATE_SQLITE_WORKER_LANE_V1.transfersWithTransactionCallback,
    false,
  );

  assert.deepEqual(
    [...SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.commands],
    ["open", "transact", "query", "drain", "close"],
  );
  assert.equal(
    SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.carriesCallerClockField,
    false,
  );
  assert.equal(
    SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.carriesWithTransactionCallback,
    false,
  );
});

test("keeps the lane surface narrow and free of adapter internals", () => {
  const channel = createScriptedChannelV1();
  const lane = createSharedStateSqliteWorkerLaneV1({
    channel: channel.factory,
    queueCapacity: 1,
    acknowledgmentTimeoutMs: 0,
    drainTimeoutMs: 50,
  });
  const members = new Set<string>();
  for (const key of Object.getOwnPropertyNames(
    Object.getPrototypeOf(lane) as object,
  )) {
    if (key !== "constructor") members.add(key);
  }
  assert.deepEqual([...members].sort(), [...LANE_PUBLIC_MEMBERS_V1]);
  // `withTransaction` is the member that cannot cross a structured-clone
  // boundary, so its absence is the load-bearing assertion here.
  assert.equal(members.has("withTransaction"), false);
});

// ---------------------------------------------------------------------------
// Protocol parsers
// ---------------------------------------------------------------------------

test("refuses a malformed worker envelope on both sides of the boundary", () => {
  const request = parseSharedStateSqliteWorkerRequestV1({
    kind: "SomethingElse",
    protocolVersion: 1,
    contractVersion: V.versions.contract,
    ticket: "1",
    command: "open",
  });
  assert.equal(request.ok, false);
  if (request.ok) throw new Error("unreachable");
  assert.equal(request.error.code, "malformed_envelope");

  // A generic method name is not in the closed command set.
  const generic = parseSharedStateSqliteWorkerRequestV1({
    kind: SHARED_STATE_SQLITE_WORKER_PROTOCOL_V1.requestKind,
    protocolVersion: 1,
    contractVersion: V.versions.contract,
    ticket: "1",
    command: "call",
  });
  assert.equal(generic.ok, false);

  const response = parseSharedStateSqliteWorkerResponseV1({ nope: true });
  assert.equal(response.ok, false);
});

test("refuses a transaction payload the closed contract parser rejects", () => {
  const valid = buildSharedStateSqliteWorkerRequestV1(
    "1",
    "transact",
    claimCommand({ owner: "o-1", expectedResourceVersion: "0" }),
  );
  assert.equal(parseSharedStateSqliteWorkerRequestV1(valid).ok, true);

  // A caller clock field is forbidden by the contract parser, so it can never
  // ride into the worker even though the envelope shape is well formed.
  const withClock = {
    ...(valid as Record<string, unknown>),
    transactionCommand: {
      ...(valid as { transactionCommand: Record<string, unknown> })
        .transactionCommand,
      observedAtUnixMs: "1000",
    },
  };
  const parsed = parseSharedStateSqliteWorkerRequestV1(withClock);
  assert.equal(parsed.ok, false);
  if (parsed.ok) throw new Error("unreachable");
  assert.equal(parsed.error.code, "invalid_payload");
});

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

test("assigns no ticket to a request that fails its parser", async () => {
  const channel = createScriptedChannelV1();
  const lane = await openScriptedLaneV1(channel, { queueCapacity: 4 });
  const beforeTickets = lane.diagnostics().admittedTickets;
  const beforePosts = channel.posted.length;

  const result = await lane.transact({
    kind: "SharedStateTransactionCommandV1",
    contractVersion: "a2a.shared-state.storage/v1",
    transactionVersion: 1,
    operationVersion: 1,
    operation: "claimLease",
    input: { namespace: "broker.test" },
  } as unknown as SharedStateTransactionCommandV1);

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.error.code, "adapter_unavailable");
  assert.equal(lane.diagnostics().admittedTickets, beforeTickets);
  assert.equal(channel.posted.length, beforePosts);
});

test("refuses a saturated queue with an operation-preserving unavailable result", async () => {
  const channel = createScriptedChannelV1();
  const lane = await openScriptedLaneV1(channel, { queueCapacity: 1 });
  const beforeTickets = lane.diagnostics().admittedTickets;

  // Occupies the single slot and is deliberately left unanswered.
  const held = lane.transact(
    claimCommand({ owner: "o-1", expectedResourceVersion: "0" }),
  );
  const refused = await lane.transact(
    claimCommand({ owner: "o-2", expectedResourceVersion: "0" }),
  );

  assert.equal(refused.ok, true);
  if (!refused.ok) throw new Error("unreachable");
  assert.equal(refused.value.operation, "claimLease");
  assert.equal(refused.value.status, "unavailable");
  if (refused.value.status !== "unavailable") throw new Error("unreachable");
  assert.equal(refused.value.reasonCode, "authority_unavailable");
  // The refusal consumed no ticket.
  assert.equal(lane.diagnostics().admittedTickets, beforeTickets + 1);

  await lane.terminate();
  const settled = await held;
  assert.equal(settled.ok, true);
});

test("dispatches accepted tickets in exact order, one at a time", async () => {
  const channel = createScriptedChannelV1();
  const lane = await openScriptedLaneV1(channel, { queueCapacity: 8 });
  const openPosts = channel.posted.length;

  const pending = [0, 1, 2, 3].map((index) =>
    lane.transact(
      claimCommand({
        owner: `o-${index}`,
        expectedResourceVersion: String(index),
      }),
    ),
  );

  // Exactly one is in flight even though four were accepted.
  assert.equal(channel.posted.length, openPosts + 1);

  for (let index = 0; index < pending.length; index += 1) {
    const posted = channel.posted[openPosts + index];
    assert.notEqual(posted, undefined);
    assert.equal(posted?.ticket, String(openPosts + index + 1));
    channel.respondValue(openPosts + index, {
      kind: V.kinds.transactionResult,
      contractVersion: V.versions.contract,
      transactionVersion: V.versions.transaction,
      operationVersion: V.versions.operation,
      operation: "claimLease",
      status: "unavailable",
      consistency: V.operationConsistency.claimLease,
      completeness: V.resultCompletenessStates[1],
      reasonCode: "authority_unavailable",
    });
    // Awaiting here is what proves each ticket settled before the next was
    // dispatched.
    const settled = pending[index];
    assert.notEqual(settled, undefined);
    await settled;
  }

  assert.equal(channel.posted.length, openPosts + pending.length);
  assert.equal(lane.diagnostics().ambiguousWrites, 0);
});

// ---------------------------------------------------------------------------
// Terminal results, ambiguity, loss
// ---------------------------------------------------------------------------

test("returns a known domain rejection verbatim", async () => {
  const channel = createScriptedChannelV1();
  const lane = await openScriptedLaneV1(channel, { queueCapacity: 2 });
  const index = channel.posted.length;

  const pending = lane.transact(
    claimCommand({ owner: "o-2", expectedResourceVersion: "1" }),
  );
  channel.respondValue(index, {
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "claimLease",
    status: "rejected",
    consistency: V.operationConsistency.claimLease,
    completeness: V.resultCompletenessStates[0],
    reasonCode: "claim_conflict",
  });

  const result = await pending;
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, "rejected");
  if (result.value.status !== "rejected") throw new Error("unreachable");
  assert.equal(result.value.reasonCode, "claim_conflict");
  // A known rollback is terminal, not ambiguous.
  assert.equal(lane.diagnostics().ambiguousWrites, 0);
  assert.equal(lane.diagnostics().state, "ready");
});

test("treats a crossed response as ambiguous and never reports committed", async () => {
  const channel = createScriptedChannelV1();
  const lane = await openScriptedLaneV1(channel, { queueCapacity: 2 });

  const pending = lane.transact(
    claimCommand({ owner: "o-1", expectedResourceVersion: "0" }),
  );
  // A response for a ticket that is not the dispatched one.
  channel.deliver(
    buildSharedStateSqliteWorkerValueResponseV1(
      "9999",
      "transact",
      lifecycleValue("ready"),
    ),
  );

  const result = await pending;
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.operation, "claimLease");
  assert.equal(result.value.status, "unavailable");
  if (result.value.status !== "unavailable") throw new Error("unreachable");
  assert.equal(result.value.reasonCode, "ambiguous_commit");

  const diagnostics = lane.diagnostics();
  assert.equal(diagnostics.ambiguousWrites, 1);
  assert.equal(diagnostics.crossedResponses, 1);
  assert.equal(diagnostics.state, "failed");
  assert.equal(diagnostics.lastLossReason, "crossed_response");
});

test("treats an acknowledgment timeout as ambiguous without retrying", async () => {
  const channel = createScriptedChannelV1();
  const lane = await openScriptedLaneV1(channel, {
    queueCapacity: 2,
    acknowledgmentTimeoutMs: 5,
  });
  const posts = channel.posted.length;

  const result = await lane.transact(
    claimCommand({ owner: "o-1", expectedResourceVersion: "0" }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, "unavailable");
  if (result.value.status !== "unavailable") throw new Error("unreachable");
  assert.equal(result.value.reasonCode, "ambiguous_commit");
  // The command was posted exactly once; a timeout is never a retry.
  assert.equal(channel.posted.length, posts + 1);
  assert.equal(lane.diagnostics().lastLossReason, "acknowledgment_timeout");
});

test("rejects queued work and makes dispatched work ambiguous on worker loss", async () => {
  const channel = createScriptedChannelV1();
  const lane = await openScriptedLaneV1(channel, { queueCapacity: 4 });

  const dispatched = lane.transact(
    claimCommand({ owner: "o-1", expectedResourceVersion: "0" }),
  );
  const queued = lane.transact(
    claimCommand({ owner: "o-2", expectedResourceVersion: "1" }),
  );

  channel.lose("worker_exit");

  const dispatchedResult = await dispatched;
  assert.equal(dispatchedResult.ok, true);
  if (!dispatchedResult.ok) throw new Error("unreachable");
  assert.equal(dispatchedResult.value.status, "unavailable");
  if (dispatchedResult.value.status !== "unavailable") {
    throw new Error("unreachable");
  }
  assert.equal(dispatchedResult.value.reasonCode, "ambiguous_commit");

  const queuedResult = await queued;
  assert.equal(queuedResult.ok, true);
  if (!queuedResult.ok) throw new Error("unreachable");
  assert.equal(queuedResult.value.status, "unavailable");
  if (queuedResult.value.status !== "unavailable") {
    throw new Error("unreachable");
  }
  // Never dispatched, so it is a refusal rather than an ambiguity.
  assert.equal(queuedResult.value.reasonCode, "authority_unavailable");

  const diagnostics = lane.diagnostics();
  assert.equal(diagnostics.ambiguousWrites, 1);
  assert.equal(diagnostics.state, "failed");
  assert.equal(diagnostics.ownershipReleased, false);
});

test("makes a later query unavailable once the barrier cannot be proved", async () => {
  const channel = createScriptedChannelV1();
  const lane = await openScriptedLaneV1(channel, { queueCapacity: 4 });

  const pending = lane.transact(
    claimCommand({ owner: "o-1", expectedResourceVersion: "0" }),
  );
  channel.lose("worker_error");
  await pending;

  const posts = channel.posted.length;
  const result = await lane.query(reconcileOutboxRequest("stream-1"));

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.operation, "reconcileOutbox");
  assert.equal(result.value.status, "unavailable");
  if (result.value.status !== "unavailable") throw new Error("unreachable");
  assert.equal(result.value.achievedConsistency, null);
  assert.equal(result.value.reasonCode, "authority_unavailable");
  // No main-thread stale read was attempted, and nothing crossed the boundary.
  assert.equal(channel.posted.length, posts);
});

// ---------------------------------------------------------------------------
// Drain and close
// ---------------------------------------------------------------------------

test("fails drain closed while an ambiguous write remains", async () => {
  const channel = createScriptedChannelV1();
  const lane = await openScriptedLaneV1(channel, { queueCapacity: 4 });

  const pending = lane.transact(
    claimCommand({ owner: "o-1", expectedResourceVersion: "0" }),
  );
  channel.lose("worker_exit");
  await pending;

  const drained = await lane.drain();
  assert.equal(drained.ok, false);
  if (drained.ok) throw new Error("unreachable");
  assert.equal(drained.error.code, "not_ready");
  assert.equal(lane.diagnostics().ownershipReleased, false);
});

test("fails drain closed when an accepted ticket never settles", async () => {
  const channel = createScriptedChannelV1();
  const lane = await openScriptedLaneV1(channel, { queueCapacity: 4 });

  // Accepted, dispatched, and deliberately never answered.
  const held = lane.transact(
    claimCommand({ owner: "o-1", expectedResourceVersion: "0" }),
  );
  const drained = await lane.drain();

  assert.equal(drained.ok, false);
  if (drained.ok) throw new Error("unreachable");
  assert.equal(drained.error.code, "adapter_unavailable");
  assert.equal(lane.diagnostics().state, "failed");
  assert.equal(lane.diagnostics().ownershipReleased, false);

  await lane.terminate();
  await held;
});

test("refuses close before a successful drain and never claims a forced close released ownership", async () => {
  const channel = createScriptedChannelV1();
  const lane = await openScriptedLaneV1(channel, { queueCapacity: 2 });

  const early = await lane.close();
  assert.equal(early.ok, false);
  if (early.ok) throw new Error("unreachable");
  assert.equal(early.error.code, "drain_required");

  await lane.terminate();
  const diagnostics = lane.diagnostics();
  assert.equal(diagnostics.ownershipReleased, false);
  assert.equal(diagnostics.state, "failed");
  assert.equal(channel.terminations, 1);
});

test("releases ownership only through drain then close", async () => {
  const channel = createScriptedChannelV1();
  const lane = await openScriptedLaneV1(channel, { queueCapacity: 2 });

  const openPosts = channel.posted.length;

  const draining = lane.drain();
  await waitForPostCountV1(channel, openPosts + 1);
  channel.respondValue(openPosts, lifecycleValue("draining"));
  const drained = await draining;
  assert.equal(drained.ok, true);
  assert.equal(lane.diagnostics().ownershipReleased, false);

  const closing = lane.close();
  await waitForPostCountV1(channel, openPosts + 2);
  channel.respondValue(openPosts + 1, lifecycleValue("closed"));
  const closed = await closing;
  assert.equal(closed.ok, true);

  const diagnostics = lane.diagnostics();
  assert.equal(diagnostics.state, "closed");
  assert.equal(diagnostics.ownershipReleased, true);
  assert.equal(channel.terminations, 1);
});

// ---------------------------------------------------------------------------
// Real worker thread
// ---------------------------------------------------------------------------

function createWorkerFixtureV1(): {
  readonly filePath: string;
  readonly lane: SharedStateSqliteWorkerLaneV1;
  dispose(): Promise<void>;
} {
  const directory = mkdtempSync(
    join(tmpdir(), "shared-state-sqlite-worker-lane-v1-"),
  );
  const filePath = join(directory, "v1.db");
  const lane = createSharedStateSqliteWorkerLaneV1({
    channel: createSharedStateSqliteWorkerThreadChannelV1({
      filePath,
      ownerToken: "worker-lane-owner",
      backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
    }),
    queueCapacity: 8,
    acknowledgmentTimeoutMs: 10_000,
    drainTimeoutMs: 10_000,
  });
  return {
    filePath,
    lane,
    async dispose(): Promise<void> {
      await lane.terminate();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("commits through a real worker before acknowledging the ticket", async () => {
  const fixture = createWorkerFixtureV1();
  try {
    const opened = await fixture.lane.open();
    assert.equal(opened.ok, true);

    const result = await fixture.lane.transact(
      claimCommand({ owner: "o-1", expectedResourceVersion: "0" }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.value.status, "committed");

    // The acknowledgment followed SQLite COMMIT, so an independent reader on
    // the same file already sees the row at the moment the promise resolved.
    const reader = new DatabaseSync(fixture.filePath, { timeout: 0 });
    try {
      const row: unknown = reader
        .prepare(`SELECT COUNT(*) AS total FROM shared_state_lease`)
        .get();
      assert.equal((row as { total: number }).total, 1);
    } finally {
      reader.close();
    }
  } finally {
    await fixture.dispose();
  }
});

test("returns a real domain rejection through the worker lane", async () => {
  const fixture = createWorkerFixtureV1();
  try {
    assert.equal((await fixture.lane.open()).ok, true);
    const first = await fixture.lane.transact(
      claimCommand({ owner: "o-1", expectedResourceVersion: "0" }),
    );
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(first.value.status, "committed");

    const second = await fixture.lane.transact(
      claimCommand({ owner: "o-2", expectedResourceVersion: "1" }),
    );
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    assert.equal(second.value.status, "rejected");
    if (second.value.status !== "rejected") throw new Error("unreachable");
    assert.equal(second.value.reasonCode, "claim_conflict");
    assert.equal(fixture.lane.diagnostics().ambiguousWrites, 0);
  } finally {
    await fixture.dispose();
  }
});

test("serves both closed query families behind the same FIFO barrier", async () => {
  const fixture = createWorkerFixtureV1();
  try {
    assert.equal((await fixture.lane.open()).ok, true);

    const appended = await fixture.lane.transact(
      appendOutboxCommand({ streamId: "stream-1", eventId: "e-1" }),
    );
    assert.equal(appended.ok, true);
    if (!appended.ok) throw new Error("unreachable");
    assert.equal(appended.value.status, "committed");

    const outbox = await fixture.lane.query(
      reconcileOutboxRequest("stream-1"),
    );
    assert.equal(outbox.ok, true);
    if (!outbox.ok) throw new Error("unreachable");
    assert.equal(outbox.value.operation, "reconcileOutbox");
    assert.equal(outbox.value.status, "succeeded");
    if (
      outbox.value.operation !== "reconcileOutbox"
      || outbox.value.status !== "succeeded"
    ) {
      throw new Error("unreachable");
    }
    assert.deepEqual(
      outbox.value.achievedConsistency,
      V.queryConsistency.reconcileOutbox,
    );
    // The query serialized after the append, so it observes that durable write.
    assert.equal(outbox.value.result.events.length, 1);

    const graph = await fixture.lane.query(graphEvidenceRequest());
    assert.equal(graph.ok, true);
    if (!graph.ok) throw new Error("unreachable");
    assert.equal(graph.value.operation, "queryGraphEvidencePath");
    assert.equal(graph.value.status, "succeeded");
  } finally {
    await fixture.dispose();
  }
});

test("releases ownership through a real worker drain and close", async () => {
  const fixture = createWorkerFixtureV1();
  try {
    assert.equal((await fixture.lane.open()).ok, true);
    assert.equal((await fixture.lane.drain()).ok, true);
    const closed = await fixture.lane.close();
    assert.equal(closed.ok, true);
    assert.equal(fixture.lane.diagnostics().ownershipReleased, true);

    const reader = new DatabaseSync(fixture.filePath, { timeout: 0 });
    try {
      const row: unknown = reader
        .prepare(`SELECT owner_token FROM shared_state_ownership WHERE id = 1`)
        .get();
      assert.equal((row as { owner_token: string | null }).owner_token, null);
    } finally {
      reader.close();
    }
  } finally {
    await fixture.dispose();
  }
});
