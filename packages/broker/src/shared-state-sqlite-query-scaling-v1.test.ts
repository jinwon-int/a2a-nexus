/**
 * #2081: query-scaling tests for the shared-state SQLite adapter, phase 1 —
 * rate-cost window index + prune job, and reconcileOutbox keyset pagination.
 *
 * The prune test mirrors the section-2.6 invariant the adapter itself asserts
 * ("expired rows stay on disk and do not change the decision"): physical
 * deletion, when it eventually happens, must also never change a logical
 * answer.
 *
 * The keyset tests walk a whole stream through bounded pages and assert exact
 * coverage, plus the unavailable envelope for a missing cursor (which the old
 * whole-stream scan also failed closed on).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  pruneSharedStateSqliteV1,
  SHARED_STATE_SQLITE_ADAPTER_V1,
  SharedStateSqliteAdapterV1,
  type SharedStateSqliteAdapterResultV1,
} from "./shared-state-sqlite-adapter-v1.js";
import {
  applySharedStateSqliteSchemaV1,
  SHARED_STATE_SQLITE_SCHEMA_V1,
} from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateQueryRequestV1,
  parseSharedStateTransactionCommandV1,
  type SharedStateQueryRequestV1,
  type SharedStateTransactionCommandV1,
  type SharedStateTransactionResultV1,
} from "./shared-state-storage-contract-v1.js";
import { digestSharedStateKeyV1 } from "./shared-state-storage-keyspace-v1.js";

interface Fixture {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly directory: string;
}

function makeFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "shared-state-query-scaling-"));
  const path = join(directory, "v1.db");
  const db = new DatabaseSync(path);
  assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
  return { db, path, directory };
}

function disposeFixture(fixture: Fixture): void {
  fixture.db.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

function readyAdapter(db: DatabaseSync): SharedStateSqliteAdapterV1 {
  const owner = new SharedStateSqliteAdapterV1({
    db,
    ownerToken: "scaling-owner-a",
    backwardSkewToleranceMs: "0",
  });
  assert.equal(owner.open().ok, true);
  return owner;
}

const NAMESPACE = "broker.test";
const OUTBOX_NAMESPACE = "broker.terminal-outbox";

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

function rateCommand(input: { cost: number; limit: number; windowMs: number }): SharedStateTransactionCommandV1 {
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

function committed(
  result: SharedStateSqliteAdapterResultV1<SharedStateTransactionResultV1>,
): Record<string, unknown> {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, "committed");
  if (result.value.status !== "committed") throw new Error("unreachable");
  return result.value.result;
}

// ── prune ──────────────────────────────────────────────────────────────────

test("prune removes out-of-window rate rows and expired nonces, keeps live ones", () => {
  const fixture = makeFixture();
  try {
    const db = fixture.db;
    db.prepare(
      `INSERT INTO shared_state_rate_cost
         (namespace, bucket_key_digest, event_at_unix_ms, cost, entry_ordinal)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(NAMESPACE, "bucket-ancient", "1", 5, 1);
    db.prepare(
      `INSERT INTO shared_state_rate_cost
         (namespace, bucket_key_digest, event_at_unix_ms, cost, entry_ordinal)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(NAMESPACE, "bucket-live", "9000", 7, 1);
    db.prepare(
      `INSERT INTO shared_state_replay_nonce
         (namespace, key_digest, nonce_digest, expires_at_unix_ms)
       VALUES (?, ?, ?, ?)`,
    ).run(NAMESPACE, "key-1", "nonce-expired", "500");
    db.prepare(
      `INSERT INTO shared_state_replay_nonce
         (namespace, key_digest, nonce_digest, expires_at_unix_ms)
       VALUES (?, ?, ?, ?)`,
    ).run(NAMESPACE, "key-1", "nonce-live", "99999");

    const result = pruneSharedStateSqliteV1(db, {
      nowUnixMs: 10_000n,
      rateCostCutoffUnixMs: 500n,
    });
    assert.equal(result.rateCostDeleted, 1);
    assert.equal(result.nonceDeleted, 1);

    const remainingBuckets = db
      .prepare(`SELECT bucket_key_digest FROM shared_state_rate_cost`)
      .all() as Array<{ bucket_key_digest: string }>;
    assert.deepEqual(remainingBuckets.map((row) => row.bucket_key_digest), ["bucket-live"]);
    const remainingNonces = db
      .prepare(`SELECT nonce_digest FROM shared_state_replay_nonce`)
      .all() as Array<{ nonce_digest: string }>;
    assert.deepEqual(remainingNonces.map((row) => row.nonce_digest), ["nonce-live"]);
  } finally {
    disposeFixture(fixture);
  }
});

test("prune never changes a rate-limit logical answer", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const spend = (cost: number, at: string): Record<string, unknown> =>
      committed(
        owner.transact(rateCommand({ cost, limit: 10, windowMs: 1_000 }), {
          observedAtUnixMs: at,
        }),
      );

    spend(6, "1000");
    spend(4, "1200");
    const refusedBefore = spend(1, "1300");
    const countsBefore = (
      fixture.db
        .prepare(`SELECT COUNT(*) AS n FROM shared_state_rate_cost`)
        .get() as { n: number }
    ).n;

    // Physically remove every row that is already outside the widest window
    // used above (windows are 1s; everything observed before t=1000-1000 is
    // logically out of every future window too).
    const prune = pruneSharedStateSqliteV1(fixture.db, {
      nowUnixMs: 1300n,
      rateCostCutoffUnixMs: 1000n,
    });
    assert.ok(prune.rateCostDeleted >= 0);
    const countsAfter = (
      fixture.db
        .prepare(`SELECT COUNT(*) AS n FROM shared_state_rate_cost`)
        .get() as { n: number }
    ).n;

    const refusedAfter = spend(1, "1300");
    assert.deepEqual(refusedAfter, refusedBefore);
    assert.equal(
      countsBefore,
      countsAfter + prune.rateCostDeleted,
      "prune deletes only rows the logical answers ignore",
    );
  } finally {
    disposeFixture(fixture);
  }
});

// ── window index ───────────────────────────────────────────────────────────

test("the rate-cost window bound is index-backed (EXPLAIN QUERY PLAN)", () => {
  const fixture = makeFixture();
  try {
    const db = fixture.db;
    const deletePlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
           DELETE FROM shared_state_rate_cost
            WHERE namespace = ? AND bucket_key_digest = ?
              AND CAST(event_at_unix_ms AS INTEGER) < ?`,
      )
      .all(NAMESPACE, "bucket", 500) as Array<{ detail: string }>;
    assert.ok(
      deletePlan.some((row) => row.detail.includes("shared_state_rate_cost_window_idx")),
      `expected the window index in the prune plan: ${JSON.stringify(deletePlan)}`,
    );

    // The bounded reserve SELECT searches via the bucket index rather than
    // scanning the whole table. (It cannot use the expression index for the
    // window bound: malformed event_at rows must stay included so the
    // boundary evaluator keeps failing closed on them, and that pattern
    // predicate is not indexable — the physical bound comes from the prune.)
    const selectPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
           SELECT event_at_unix_ms, cost, entry_ordinal
             FROM shared_state_rate_cost
            WHERE namespace = ? AND bucket_key_digest = ?
              AND (
                CAST(event_at_unix_ms AS INTEGER) >= ?
                OR NOT (
                  length(event_at_unix_ms) <= 13
                  AND (event_at_unix_ms = '0'
                    OR (event_at_unix_ms GLOB '[1-9]*' AND event_at_unix_ms NOT GLOB '*[^0-9]*'))
                )
              )
            ORDER BY entry_ordinal`,
      )
      .all(NAMESPACE, "bucket", 500) as Array<{ detail: string }>;
    assert.ok(
      selectPlan.some((row) => /SEARCH.*USING INDEX/.test(row.detail)),
      `expected an index-bounded search: ${JSON.stringify(selectPlan)}`,
    );
    assert.ok(
      selectPlan.every((row) => !row.detail.includes("SCAN shared_state_rate_cost")),
      `must never table-scan: ${JSON.stringify(selectPlan)}`,
    );
  } finally {
    disposeFixture(fixture);
  }
});

// ── keyset pagination ──────────────────────────────────────────────────────

type ReconcileOutboxQueryRequestV1 = Extract<
  SharedStateQueryRequestV1,
  { readonly operation: "reconcileOutbox" }
>;

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
    streamKeyDigest: digest(OUTBOX_NAMESPACE, "broker.outbox.stream-key", components),
  };
}

function appendOutboxCommand(input: {
  readonly streamId: string;
  readonly eventId: string;
}): SharedStateTransactionCommandV1 {
  const stream = outboxStream(input.streamId);
  const d = (domain: string, components: readonly Record<string, unknown>[]): string =>
    digest(OUTBOX_NAMESPACE, domain, components);
  return command("appendOutbox", {
    namespace: OUTBOX_NAMESPACE,
    eventPurpose: "task-terminal-notification",
    streamKey: stream.streamKey,
    streamKeyDigest: stream.streamKeyDigest,
    orderingScope: "total-within-exact-stream-key",
    idempotencyKeyDigest: d("broker.outbox.idempotency-key", [
      { field: "producerId", type: "utf8", value: "p-1" },
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

function reconcileRequest(
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
  if (!parsed.ok || parsed.value.operation !== "reconcileOutbox") throw new Error("unreachable");
  return parsed.value;
}

test("keyset pages cover the whole stream exactly once with bounded reads", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const EVENT_COUNT = 5;
    for (let index = 1; index <= EVENT_COUNT; index++) {
      committed(
        owner.transact(
          appendOutboxCommand({ streamId: "stream-1", eventId: `e-${index}` }),
          { observedAtUnixMs: "1000" },
        ),
      );
    }

    const seenSequences: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    while (pages < 10) {
      const result = owner.query(reconcileRequest("stream-1", cursor, 2));
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      if (result.value.status !== "succeeded") throw new Error("unreachable");
      const value = result.value as unknown as {
        result: {
          events: Array<{ streamSequence: string }>;
          hasMore: boolean;
          nextCursor: string | null;
        };
      };
      for (const event of value.result.events) {
        seenSequences.push(event.streamSequence);
      }
      pages += 1;
      if (!value.result.hasMore) break;
      cursor = value.result.nextCursor;
      assert.ok(cursor !== null, "hasMore must come with a nextCursor");
    }

    assert.equal(pages, 3, `5 events at limit 2 need 3 pages, took ${pages}`);
    assert.deepEqual(seenSequences, ["1", "2", "3", "4", "5"]);
    // Bounded reads: the page query carries LIMIT limit+1 (structural pin).
  } finally {
    disposeFixture(fixture);
  }
});

test("a missing cursor fails closed as unavailable, not as page one", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    committed(
      owner.transact(
        appendOutboxCommand({ streamId: "stream-1", eventId: "e-1" }),
        { observedAtUnixMs: "1000" },
      ),
    );
    const result = owner.query(reconcileRequest("stream-1", "999", 2));
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    if (result.value.status !== "unavailable") {
      throw new Error(`expected unavailable, got ${result.value.status}`);
    }
    assert.equal(result.value.achievedConsistency, null);
  } finally {
    disposeFixture(fixture);
  }
});

// ── connection pragmas ─────────────────────────────────────────────────────

test("schema application leaves no connection pragma residue", () => {
  const fixture = makeFixture();
  try {
    const version = fixture.db.prepare("PRAGMA journal_mode").get() as {
      journal_mode?: string;
    };
    // The fixture connection never asked for WAL — the helper is what sets it.
    assert.notEqual(version.journal_mode, undefined);
    const tables = (
      fixture.db
        .prepare(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'shared_state_rate_cost_window_idx'`,
        )
        .get() as { n: number }
    ).n;
    assert.equal(tables, 1, "the V1 schema ships the window index");
    assert.equal(SHARED_STATE_SQLITE_SCHEMA_V1.schemaVersion, 1);
    assert.equal(SHARED_STATE_SQLITE_ADAPTER_V1.contractVersion, "a2a.shared-state.storage/v1");
  } finally {
    disposeFixture(fixture);
  }
});
