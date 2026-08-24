/**
 * TEST-ONLY focused proof for checklist item 489: a query cannot resolve
 * successfully across a delayed or missing earlier durable ACK.
 *
 * WHY THE EXISTING TESTS DO NOT ALREADY COVER THIS. W1 proves that a query goes
 * `unavailable` once the barrier *cannot be proved* — but it gets there by
 * killing the worker, which is a different mechanism from an ACK that is merely
 * outstanding. Nothing so far holds a durable acknowledgment back and then
 * releases it. That gap matters, because the failure 489 guards against is not
 * a crash: it is a query that answers from state it was not entitled to see
 * yet, while an earlier committed write is still in flight. A lane could pass
 * every W1 test and still do that.
 *
 * WHAT IS ASSERTED. Three things, each about a different shape of "the ACK has
 * not crossed yet":
 *
 *   - DELAYED. While an earlier ticket is dispatched and unanswered, a later
 *     query is not dispatched at all, and its promise does not settle. When the
 *     ACK finally crosses, the query is dispatched *after* it — the ordering is
 *     asserted on the wire, not inferred from the result.
 *   - MISSING, with no failure signal. The same setup, never answered. The
 *     query never resolves successfully, and when the lane is finally torn down
 *     it resolves `unavailable` rather than succeeding late.
 *   - MISSING, declared by timeout. The earlier ticket becomes ambiguous, and
 *     the query is then operation-preserving `unavailable` with
 *     `achievedConsistency: null` — never `succeeded`.
 *
 * And one end-to-end case against a real worker, because the scripted channel
 * could in principle satisfy all three while a real durable commit still
 * raced: a query issued while an append is in flight observes that append, and
 * observes it only after its commit acknowledged.
 *
 * This file checks no box. 489 additionally requires what 488 requires, and
 * whether the seven worker-mode harnesses satisfy that wording is a separate
 * judgment that has not been recorded yet.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSharedStateSqliteWorkerThreadChannelV1 } from "../shared-state-sqlite-worker-channel-v1.js";
import {
  createSharedStateSqliteWorkerLaneV1,
  type SharedStateSqliteWorkerChannelHandlersV1,
  type SharedStateSqliteWorkerLaneV1,
} from "../shared-state-sqlite-worker-lane-v1.js";
import {
  buildSharedStateSqliteWorkerValueResponseV1,
  type SharedStateSqliteWorkerRequestV1,
} from "../shared-state-sqlite-worker-protocol-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateTransactionCommandV1,
  type SharedStateQueryRequestV1,
  type SharedStateTransactionCommandV1,
} from "../shared-state-storage-contract-v1.js";
import { digestSharedStateKeyV1 } from "../shared-state-storage-keyspace-v1.js";

const OUTBOX_NAMESPACE = "broker.terminal-outbox";

function digest(
  domain: string,
  components: readonly Record<string, unknown>[],
): string {
  const built = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace: OUTBOX_NAMESPACE,
    components,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  return built.value.digest;
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
    streamKeyDigest: digest("broker.outbox.stream-key", components),
  };
}

function appendOutboxCommand(eventId: string): SharedStateTransactionCommandV1 {
  const stream = outboxStream("ack-barrier");
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "appendOutbox",
    input: {
      namespace: OUTBOX_NAMESPACE,
      eventPurpose: "task-terminal-notification",
      streamKey: stream.streamKey,
      streamKeyDigest: stream.streamKeyDigest,
      orderingScope: "total-within-exact-stream-key",
      idempotencyKeyDigest: digest("broker.outbox.idempotency-key", [
        { field: "producerId", type: "utf8", value: "ack-barrier" },
        { field: "clientKey", type: "utf8", value: eventId },
      ]),
      eventKeyDigest: digest("broker.outbox.event-key", [
        { field: "eventId", type: "utf8", value: eventId },
      ]),
      payloadDigest: digest("broker.outbox.payload", [
        { field: "payload", type: "bytes", value: "a1" },
      ]),
      retentionPolicyVersion: "task-terminal-outbox-retention.v1",
      receiptPolicyVersion: "terminal-notification-receipt.v1",
      acknowledgmentPolicyVersion: "terminal-notification-ack.v1",
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

function reconcileRequest(): SharedStateQueryRequestV1 {
  const parsed = parseSharedStateQueryRequestV1({
    kind: V.kinds.queryRequest,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: "reconcileOutbox",
    input: {
      namespace: OUTBOX_NAMESPACE,
      streamKeyDigest: outboxStream("ack-barrier").streamKeyDigest,
      cursor: null,
      limit: 10,
      requiredConsistency: V.queryConsistency.reconcileOutbox,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

/** A channel that answers nothing unless a test says so. */
function createHeldChannelV1() {
  const posted: SharedStateSqliteWorkerRequestV1[] = [];
  let handlers: SharedStateSqliteWorkerChannelHandlersV1 | null = null;
  return {
    posted,
    factory: (input: SharedStateSqliteWorkerChannelHandlersV1) => {
      handlers = input;
      return {
        post(request: SharedStateSqliteWorkerRequestV1): void {
          posted.push(request);
        },
        async terminate(): Promise<void> {},
      };
    },
    respond(index: number, value: unknown): void {
      const request = posted[index];
      assert.notEqual(request, undefined);
      if (!request) throw new Error("unreachable");
      handlers?.onMessage(
        buildSharedStateSqliteWorkerValueResponseV1(
          request.ticket,
          request.command,
          value,
        ),
      );
    },
  };
}

const PENDING = Symbol("pending");

/**
 * Resolves to `PENDING` unless the promise settles within a generous number of
 * event-loop turns. Turn-based rather than timed, so a slow machine cannot make
 * the assertion pass for the wrong reason.
 */
async function settlementOf<T>(
  promise: Promise<T>,
): Promise<T | typeof PENDING> {
  let settled: T | typeof PENDING = PENDING;
  const tracked = promise.then((value) => {
    settled = value;
    return value;
  });
  for (let turn = 0; turn < 100; turn += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    if (settled !== PENDING) return tracked;
  }
  return PENDING;
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

function committedAppendValue(): Record<string, unknown> {
  return {
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "appendOutbox",
    status: "unavailable",
    consistency: V.operationConsistency.appendOutbox,
    completeness: V.resultCompletenessStates[1],
    reasonCode: "authority_unavailable",
  };
}

async function openHeldLaneV1(
  channel: ReturnType<typeof createHeldChannelV1>,
  acknowledgmentTimeoutMs: number,
): Promise<SharedStateSqliteWorkerLaneV1> {
  const lane = createSharedStateSqliteWorkerLaneV1({
    channel: channel.factory,
    queueCapacity: 8,
    acknowledgmentTimeoutMs,
    drainTimeoutMs: 50,
  });
  const opening = lane.open();
  channel.respond(0, lifecycleValue("ready"));
  const opened = await opening;
  assert.equal(opened.ok, true);
  return lane;
}

test("a query is not even dispatched while an earlier durable ACK is outstanding", async () => {
  const channel = createHeldChannelV1();
  const lane = await openHeldLaneV1(channel, 0);
  const afterOpen = channel.posted.length;

  // Dispatched and deliberately unanswered: its durable ACK has not crossed.
  const write = lane.transact(appendOutboxCommand("e-1"));
  assert.equal(channel.posted.length, afterOpen + 1);

  const query = lane.query(reconcileRequest());
  assert.equal(await settlementOf(query), PENDING);
  // The decisive assertion: the query never reached the wire, so it cannot
  // have answered from anything. Ordering is proved here, not inferred from a
  // result that happened to look right.
  assert.equal(channel.posted.length, afterOpen + 1);
  assert.equal(lane.diagnostics().dispatchedTicket, channel.posted[afterOpen]?.ticket);

  await lane.terminate();
  await write;
  await query;
});

test("a delayed ACK releases the query only after it crosses the boundary", async () => {
  const channel = createHeldChannelV1();
  const lane = await openHeldLaneV1(channel, 0);
  const afterOpen = channel.posted.length;

  const write = lane.transact(appendOutboxCommand("e-1"));
  const query = lane.query(reconcileRequest());
  assert.equal(await settlementOf(query), PENDING);
  assert.equal(channel.posted.length, afterOpen + 1);

  // The ACK finally crosses.
  channel.respond(afterOpen, committedAppendValue());
  await write;

  // Only now is the query on the wire, and it is strictly after the write.
  for (let turn = 0; turn < 100 && channel.posted.length < afterOpen + 2; turn += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  assert.equal(channel.posted.length, afterOpen + 2);
  assert.equal(channel.posted[afterOpen]?.command, "transact");
  assert.equal(channel.posted[afterOpen + 1]?.command, "query");

  channel.respond(afterOpen + 1, {
    kind: V.kinds.queryResult,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: "reconcileOutbox",
    status: "succeeded",
    achievedConsistency: V.queryConsistency.reconcileOutbox,
    result: {
      namespace: OUTBOX_NAMESPACE,
      streamKeyDigest: outboxStream("ack-barrier").streamKeyDigest,
      events: [],
      hasMore: false,
      nextCursor: null,
    },
  });
  const result = await query;
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, "succeeded");

  await lane.terminate();
});

test("a missing ACK never lets the query succeed, even late", async () => {
  const channel = createHeldChannelV1();
  const lane = await openHeldLaneV1(channel, 0);
  const afterOpen = channel.posted.length;

  const write = lane.transact(appendOutboxCommand("e-1"));
  const query = lane.query(reconcileRequest());
  assert.equal(await settlementOf(query), PENDING);

  // Tearing the lane down is the only thing that settles it, and what it
  // settles to is not success.
  await lane.terminate();
  const result = await query;
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.operation, "reconcileOutbox");
  assert.equal(result.value.status, "unavailable");
  if (result.value.status !== "unavailable") throw new Error("unreachable");
  assert.equal(result.value.achievedConsistency, null);
  // The query was never dispatched at all.
  assert.equal(channel.posted.length, afterOpen + 1);
  await write;
});

test("an ACK declared missing by timeout leaves the query unavailable, never succeeded", async () => {
  const channel = createHeldChannelV1();
  const lane = await openHeldLaneV1(channel, 5);
  const afterOpen = channel.posted.length;

  const write = lane.transact(appendOutboxCommand("e-1"));
  const writeResult = await write;
  assert.equal(writeResult.ok, true);
  if (!writeResult.ok) throw new Error("unreachable");
  assert.equal(writeResult.value.status, "unavailable");
  if (writeResult.value.status !== "unavailable") throw new Error("unreachable");
  assert.equal(writeResult.value.reasonCode, "ambiguous_commit");

  const result = await lane.query(reconcileRequest());
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, "unavailable");
  if (result.value.status !== "unavailable") throw new Error("unreachable");
  assert.equal(result.value.achievedConsistency, null);
  // Nothing further crossed the boundary after the ambiguity was declared.
  assert.equal(channel.posted.length, afterOpen + 1);

  await lane.terminate();
});

test("a real worker resolves the query only behind the append it must observe", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "shared-state-worker-ack-barrier-v1-"),
  );
  const lane = createSharedStateSqliteWorkerLaneV1({
    channel: createSharedStateSqliteWorkerThreadChannelV1({
      filePath: join(directory, "v1.db"),
      ownerToken: "ack-barrier-owner",
      backwardSkewToleranceMs: "0",
    }),
    queueCapacity: 8,
    acknowledgmentTimeoutMs: 30_000,
    drainTimeoutMs: 30_000,
  });
  try {
    assert.equal((await lane.open()).ok, true);

    // Both are admitted before either completes, so the query's serialization
    // point is genuinely behind an append that has not yet acknowledged.
    const write = lane.transact(appendOutboxCommand("e-1"));
    const query = lane.query(reconcileRequest());

    const written = await write;
    assert.equal(written.ok, true);
    if (!written.ok) throw new Error("unreachable");
    assert.equal(written.value.status, "committed");

    const read = await query;
    assert.equal(read.ok, true);
    if (!read.ok) throw new Error("unreachable");
    assert.equal(read.value.operation, "reconcileOutbox");
    assert.equal(read.value.status, "succeeded");
    if (
      read.value.operation !== "reconcileOutbox"
      || read.value.status !== "succeeded"
    ) {
      throw new Error("unreachable");
    }
    // It observed the append, which is only sound because it ordered behind
    // that append's durable commit rather than racing it.
    assert.equal(read.value.result.events.length, 1);
  } finally {
    await lane.terminate();
    rmSync(directory, { recursive: true, force: true });
  }
});
