import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_SQLITE_ADAPTER_V1,
  SharedStateSqliteAdapterV1,
  type SharedStateSqliteAdapterResultV1,
} from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateTransactionCommandV1,
  type SharedStateQueryRequestV1,
  type SharedStateQueryResultV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";
import { digestSharedStateKeyV1 } from "./shared-state-storage-keyspace-v1.js";

interface Fixture {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly directory: string;
}

type ReconcileOutboxQueryRequestV1 = Extract<
  SharedStateQueryRequestV1,
  { readonly operation: "reconcileOutbox" }
>;

const OUTBOX_NAMESPACE = "broker.terminal-outbox";

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "shared-state-query-outbox-"));
  const path = join(directory, "v1.db");
  const db = new DatabaseSync(path);
  assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
  return { db, path, directory };
}

function disposeFixture(fixture: Fixture, extra: DatabaseSync[] = []): void {
  for (const handle of extra) handle.close();
  fixture.db.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

function readyAdapter(db: DatabaseSync): SharedStateSqliteAdapterV1 {
  const owner = new SharedStateSqliteAdapterV1({
    db,
    ownerToken: "query-owner-a",
    backwardSkewToleranceMs: "0",
  });
  assert.equal(owner.open().ok, true);
  return owner;
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

function appendCommand(input: {
  readonly index: number;
  readonly streamId?: string;
}): SharedStateTransactionCommandV1 {
  const stream = outboxStream(input.streamId ?? "stream-1");
  const value = input.index.toString(16).padStart(2, "0");
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
      idempotencyKeyDigest: digest(
        OUTBOX_NAMESPACE,
        "broker.outbox.idempotency-key",
        [
          { field: "producerId", type: "utf8", value: "query-test" },
          { field: "clientKey", type: "utf8", value: `c-${input.index}` },
        ],
      ),
      eventKeyDigest: digest(
        OUTBOX_NAMESPACE,
        "broker.outbox.event-key",
        [{ field: "eventId", type: "utf8", value: `e-${input.index}` }],
      ),
      payloadDigest: digest(
        OUTBOX_NAMESPACE,
        "broker.outbox.payload",
        [{ field: "payload", type: "bytes", value }],
      ),
      retentionPolicyVersion: "task-terminal-outbox-retention.v1",
      receiptPolicyVersion: "terminal-notification-receipt.v1",
      acknowledgmentPolicyVersion: "terminal-notification-ack.v1",
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

function append(
  owner: SharedStateSqliteAdapterV1,
  index: number,
  streamId = "stream-1",
): Record<string, unknown> {
  const result = owner.transact(appendCommand({ index, streamId }), {
    observedAtUnixMs: String(1_000 + index),
  });
  return committed(result);
}

function committed(
  result: SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1>,
): Record<string, unknown> {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, "committed");
  if (result.value.status !== "committed") throw new Error("unreachable");
  return result.value.result;
}

function queryRequest(
  streamId: string,
  cursor: string | null,
  limit: number,
): ReconcileOutboxQueryRequestV1 {
  const parsed = parseSharedStateQueryRequestV1({
    kind: V.kinds.queryRequest,
    contractVersion: V.versions.contract,
    queryVersion: V.versions.query,
    operation: "reconcileOutbox",
    input: {
      namespace: OUTBOX_NAMESPACE,
      streamKeyDigest: outboxStream(streamId).streamKeyDigest,
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

function queryValue(
  result: SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>,
): SharedStateQueryResultV1 {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

function succeeded(
  result: SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>,
): Extract<
  SharedStateQueryResultV1,
  { readonly operation: "reconcileOutbox"; readonly status: "succeeded" }
>["result"] {
  const value = queryValue(result);
  assert.equal(value.operation, "reconcileOutbox");
  assert.equal(value.status, "succeeded");
  if (value.operation !== "reconcileOutbox" || value.status !== "succeeded") {
    throw new Error("unreachable");
  }
  assert.deepEqual(
    value.achievedConsistency,
    V.queryConsistency.reconcileOutbox,
  );
  return value.result;
}

function unavailable(
  result: SharedStateSqliteAdapterResultV1<SharedStateQueryResultV1>,
): string {
  const value = queryValue(result);
  assert.equal(value.operation, "reconcileOutbox");
  assert.equal(value.status, "unavailable");
  if (value.operation !== "reconcileOutbox" || value.status !== "unavailable") {
    throw new Error("unreachable");
  }
  assert.equal(value.achievedConsistency, null);
  return value.reasonCode;
}

test("pages stored receipt/ACK state without changing it", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const empty = succeeded(owner.query(queryRequest("stream-1", null, 2)));
    assert.deepEqual(empty.events, []);
    assert.equal(empty.hasMore, false);
    assert.equal(empty.nextCursor, null);

    append(owner, 1);
    const second = append(owner, 2);
    append(owner, 3);
    fixture.db
      .prepare(
        `UPDATE shared_state_outbox
            SET receipt_state = ?, acknowledgment_state = ?
          WHERE namespace = ? AND stream_key_digest = ?
            AND event_key_digest = ?`,
      )
      .run(
        "confirmed",
        "acknowledged",
        OUTBOX_NAMESPACE,
        outboxStream("stream-1").streamKeyDigest,
        String(second.eventKeyDigest),
      );

    const firstPage = succeeded(
      owner.query(queryRequest("stream-1", null, 2)),
    );
    assert.deepEqual(
      firstPage.events.map((event) => event.streamSequence),
      ["1", "2"],
    );
    assert.equal(firstPage.events[1]?.receiptState, "confirmed");
    assert.equal(firstPage.events[1]?.acknowledgmentState, "acknowledged");
    assert.equal(firstPage.hasMore, true);
    assert.notEqual(firstPage.nextCursor, null);

    const secondPage = succeeded(
      owner.query(queryRequest("stream-1", firstPage.nextCursor, 2)),
    );
    assert.deepEqual(
      secondPage.events.map((event) => event.streamSequence),
      ["3"],
    );
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.nextCursor, null);
  } finally {
    disposeFixture(fixture);
  }
});

test("orders decimal TEXT sequences numerically through eleven", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    for (let index = 1; index <= 11; index += 1) append(owner, index);

    const page = succeeded(owner.query(queryRequest("stream-1", null, 100)));
    assert.deepEqual(
      page.events.map((event) => event.streamSequence),
      Array.from({ length: 11 }, (_, index) => String(index + 1)),
    );
  } finally {
    disposeFixture(fixture);
  }
});

test("binds opaque cursors to the exact stream and fails closed on tampering", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    append(owner, 1);
    append(owner, 2);
    append(owner, 3);
    append(owner, 10, "stream-2");

    const page = succeeded(owner.query(queryRequest("stream-1", null, 2)));
    assert.notEqual(page.nextCursor, null);
    const cursor = page.nextCursor!;

    assert.equal(
      unavailable(owner.query(queryRequest("stream-2", cursor, 2))),
      "authority_unavailable",
    );
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("0") ? "1" : "0"}`;
    assert.equal(
      unavailable(owner.query(queryRequest("stream-1", tampered, 2))),
      "authority_unavailable",
    );
  } finally {
    disposeFixture(fixture);
  }
});

test("returns closed unavailable for a busy writer and lost ownership", () => {
  const locked = makeFixture();
  const blocker = new DatabaseSync(locked.path);
  try {
    const owner = readyAdapter(locked.db);
    blocker.exec("BEGIN IMMEDIATE");
    assert.equal(
      unavailable(owner.query(queryRequest("stream-1", null, 2))),
      "lock_timeout",
    );
    blocker.exec("ROLLBACK");
  } finally {
    disposeFixture(locked, [blocker]);
  }

  const lost = makeFixture();
  try {
    const owner = readyAdapter(lost.db);
    lost.db
      .prepare(`UPDATE shared_state_ownership SET owner_token = ? WHERE id = ?`)
      .run("query-owner-b", SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);
    assert.equal(
      unavailable(owner.query(queryRequest("stream-1", null, 2))),
      "lost_ownership",
    );
    assert.equal(owner.lifecycle()?.state, "failed");
  } finally {
    disposeFixture(lost);
  }
});

test("does not emit a successful page from malformed durable state", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    append(owner, 1);
    append(owner, 2);
    const event = append(owner, 3);
    fixture.db
      .prepare(
        `UPDATE shared_state_outbox SET receipt_state = ?
          WHERE namespace = ? AND event_key_digest = ?`,
      )
      .run("invented", OUTBOX_NAMESPACE, String(event.eventKeyDigest));

    assert.equal(
      unavailable(owner.query(queryRequest("stream-1", null, 1))),
      "authority_unavailable",
    );
  } finally {
    disposeFixture(fixture);
  }
});

test("keeps outbox reads outside the pre-open lifecycle", () => {
  const fixture = makeFixture();
  try {
    const owner = new SharedStateSqliteAdapterV1({
      db: fixture.db,
      ownerToken: "query-owner-a",
      backwardSkewToleranceMs: "0",
    });
    const beforeOpen = owner.query(queryRequest("stream-1", null, 2));
    assert.equal(beforeOpen.ok, false);
    if (!beforeOpen.ok) assert.equal(beforeOpen.error.code, "not_ready");
    assert.equal(owner.open().ok, true);
    assert.deepEqual(
      succeeded(owner.query(queryRequest("stream-1", null, 2))).events,
      [],
    );
  } finally {
    disposeFixture(fixture);
  }
});
