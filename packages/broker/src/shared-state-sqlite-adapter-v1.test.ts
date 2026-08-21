/**
 * Tests for the V1 SQLite adapter: lifecycle, ownership, and the replay and
 * rate primitives.
 *
 * Exclusive ownership is the property this whole contract exists to obtain,
 * so it gets the most attention here: a second owner must be refused, a
 * refused owner must not have moved the epoch, and an adapter whose row was
 * taken over must stop being able to write.
 *
 * The primitive tests are written against what can go wrong rather than what
 * usually happens: the expiry instant itself (`expiry-1`, `expiry`,
 * `expiry+1`), a decision taken while expired rows are still on disk, a
 * backward clock, and a command issued by a session that silently lost
 * ownership. Each of the last three also asserts that nothing was written.
 *
 * Every database is a temporary file removed at the end of its test.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1,
  SHARED_STATE_SQLITE_ADAPTER_V1,
  SharedStateSqliteAdapterV1,
  readSharedStateSqliteLifecycleEpochV1,
} from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateTransactionCommandV1,
  type SharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";
import { digestSharedStateKeyV1 } from "./shared-state-storage-keyspace-v1.js";

interface Fixture {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly directory: string;
}

function makeFixture(applySchema = true): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "shared-state-adapter-v1-"));
  const path = join(directory, "v1.db");
  const db = new DatabaseSync(path);
  if (applySchema) {
    assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
  }
  return { db, path, directory };
}

function disposeFixture(fixture: Fixture, extra: DatabaseSync[] = []): void {
  for (const handle of extra) handle.close();
  fixture.db.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

function adapter(
  db: DatabaseSync,
  ownerToken: string,
  backwardSkewToleranceMs = "0",
): SharedStateSqliteAdapterV1 {
  return new SharedStateSqliteAdapterV1({
    db,
    ownerToken,
    backwardSkewToleranceMs,
  });
}

const NAMESPACE = "broker.test";

function digest(
  domain: string,
  components: readonly Record<string, unknown>[],
): string {
  const built = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace: NAMESPACE,
    components,
  });
  assert.equal(built.ok, true);
  if (!built.ok) throw new Error("unreachable");
  return built.value.digest;
}

function command(
  operation: "consumeReplayNonce" | "reserveRateLimitCost",
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

function replayCommand(input: {
  readonly nonce: string;
  readonly ttlMs: number;
}): SharedStateTransactionCommandV1 {
  return command("consumeReplayNonce", {
    keyDigest: digest("security.replay.requester-key", [
      { field: "requesterId", type: "utf8", value: "requester-1" },
    ]),
    nonceDigest: digest("security.replay.nonce", [
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
    bucketKeyDigest: digest("security.rate-limit.bucket-key", [
      { field: "principal", type: "utf8", value: "principal-1" },
      { field: "route", type: "utf8", value: "route-1" },
    ]),
    cost: input.cost,
    limit: input.limit,
    windowMs: input.windowMs,
  });
}

/**
 * Opens a ready adapter with the clock floor at zero.
 */
function readyAdapter(
  db: DatabaseSync,
  ownerToken = "owner-a",
): SharedStateSqliteAdapterV1 {
  const owner = adapter(db, ownerToken);
  assert.equal(owner.open().ok, true);
  return owner;
}

function committed(
  result: ReturnType<SharedStateSqliteAdapterV1["transact"]>,
): Record<string, unknown> {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, V.transactionStatuses[0]);
  if (result.value.status !== V.transactionStatuses[0]) {
    throw new Error("unreachable");
  }
  return result.value.result as unknown as Record<string, unknown>;
}

test("opens to ready and advances the lifecycle epoch", () => {
  const fixture = makeFixture();
  try {
    const epochBefore = readSharedStateSqliteLifecycleEpochV1(fixture.db);
    assert.equal(epochBefore.ok, true);
    if (!epochBefore.ok) return;
    assert.equal(epochBefore.value, "0");

    const owner = adapter(fixture.db, "owner-a");
    const opened = owner.open();
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(opened.value.state, "ready");
    assert.deepEqual([...opened.value.reasonCodes], []);
    assert.equal(owner.lifecycleEpoch, "1");

    const epochAfter = readSharedStateSqliteLifecycleEpochV1(fixture.db);
    assert.equal(epochAfter.ok, true);
    if (!epochAfter.ok) return;
    assert.equal(epochAfter.value, "1");
  } finally {
    disposeFixture(fixture);
  }
});

test("refuses a second owner and leaves the epoch untouched", () => {
  const fixture = makeFixture();
  const second = new DatabaseSync(fixture.path);
  try {
    const first = adapter(fixture.db, "owner-a");
    assert.equal(first.open().ok, true);
    assert.equal(first.lifecycleEpoch, "1");

    // A different session on the same database file.
    const rival = adapter(second, "owner-b");
    const refused = rival.open();
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.error.code, "ownership_conflict");
    assert.equal(rival.lifecycleEpoch, null);

    // The refusal must not have consumed an epoch.
    const epoch = readSharedStateSqliteLifecycleEpochV1(fixture.db);
    assert.equal(epoch.ok, true);
    if (!epoch.ok) return;
    assert.equal(epoch.value, "1");

    // The refused adapter cannot write either.
    const write = rival.beginWrite();
    assert.equal(write.ok, false);
    if (write.ok) return;
    assert.equal(write.error.code, "not_ready");

    // The holder still can.
    assert.equal(first.beginWrite().ok, true);
  } finally {
    disposeFixture(fixture, [second]);
  }
});

test("releases ownership only after drain, and reopening lifts the epoch", () => {
  const fixture = makeFixture();
  const second = new DatabaseSync(fixture.path);
  try {
    const first = adapter(fixture.db, "owner-a");
    assert.equal(first.open().ok, true);

    // close before drain is refused.
    const early = first.close();
    assert.equal(early.ok, false);
    if (early.ok) return;
    assert.equal(early.error.code, "drain_required");

    const drained = first.drain();
    assert.equal(drained.ok, true);
    if (!drained.ok) return;
    assert.equal(drained.value.state, "draining");
    assert.deepEqual([...drained.value.reasonCodes], ["drain_requested"]);

    // Draining already stops writes.
    const blocked = first.beginWrite();
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.error.code, "not_ready");

    const closed = first.close();
    assert.equal(closed.ok, true);
    if (!closed.ok) return;
    assert.equal(closed.value.state, "closed");
    assert.deepEqual([...closed.value.reasonCodes], ["close_requested"]);

    // Ownership is free, so a different session may now take it — and the
    // epoch rises rather than resetting.
    const next = adapter(second, "owner-b");
    assert.equal(next.open().ok, true);
    assert.equal(next.lifecycleEpoch, "2");
    const epoch = readSharedStateSqliteLifecycleEpochV1(fixture.db);
    assert.equal(epoch.ok, true);
    if (!epoch.ok) return;
    assert.equal(epoch.value, "2");
  } finally {
    disposeFixture(fixture, [second]);
  }
});

test("the epoch never decreases across repeated close and reopen", () => {
  const fixture = makeFixture();
  try {
    let previous = 0n;
    for (let round = 0; round < 4; round += 1) {
      const owner = adapter(fixture.db, `owner-${round}`);
      assert.equal(owner.open().ok, true);
      const current = BigInt(owner.lifecycleEpoch ?? "-1");
      assert.equal(current > previous, true);
      previous = current;
      assert.equal(owner.drain().ok, true);
      assert.equal(owner.close().ok, true);

      // Released ownership does not lower the epoch.
      const persisted = readSharedStateSqliteLifecycleEpochV1(fixture.db);
      assert.equal(persisted.ok, true);
      if (!persisted.ok) return;
      assert.equal(BigInt(persisted.value), current);
    }
    assert.equal(previous, 4n);
  } finally {
    disposeFixture(fixture);
  }
});

test("stops writing when its ownership row is taken over", () => {
  const fixture = makeFixture();
  try {
    const owner = adapter(fixture.db, "owner-a");
    assert.equal(owner.open().ok, true);
    assert.equal(owner.beginWrite().ok, true);

    // Simulate the row being claimed by another session while this adapter
    // still believes it is ready.
    fixture.db
      .prepare(
        `UPDATE shared_state_ownership SET owner_token = ? WHERE id = ?`,
      )
      .run("owner-b", SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);

    const lost = owner.beginWrite();
    assert.equal(lost.ok, false);
    if (lost.ok) return;
    assert.equal(lost.error.code, "ownership_lost");

    // It stays unable to write; the state moved to failed.
    const again = owner.beginWrite();
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.error.code, "not_ready");
    assert.equal(owner.lifecycle()?.state, "failed");
  } finally {
    disposeFixture(fixture);
  }
});

test("an epoch bump alone also stops the stale session writing", () => {
  const fixture = makeFixture();
  try {
    const owner = adapter(fixture.db, "owner-a");
    assert.equal(owner.open().ok, true);

    // Same token, higher epoch: a newer session of the same owner.
    fixture.db
      .prepare(
        `UPDATE shared_state_ownership SET lifecycle_epoch = ? WHERE id = ?`,
      )
      .run("99", SHARED_STATE_SQLITE_ADAPTER_V1.ownershipRowId);

    const stale = owner.beginWrite();
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.error.code, "ownership_lost");
  } finally {
    disposeFixture(fixture);
  }
});

test("refuses to open without a schema or against a foreign version", () => {
  const bare = makeFixture(false);
  try {
    const owner = adapter(bare.db, "owner-a");
    const refused = owner.open();
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.error.code, "schema_not_applied");
    assert.equal(owner.lifecycle()?.state, "failed");
  } finally {
    disposeFixture(bare);
  }

  const foreign = makeFixture();
  try {
    foreign.db
      .prepare(`UPDATE shared_state_meta SET value = ? WHERE key = ?`)
      .run("999", "schema_version");
    const owner = adapter(foreign.db, "owner-a");
    const refused = owner.open();
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.error.code, "schema_version_mismatch");
  } finally {
    disposeFixture(foreign);
  }
});

test("rejects reopening an already-open adapter", () => {
  const fixture = makeFixture();
  try {
    const owner = adapter(fixture.db, "owner-a");
    assert.equal(owner.open().ok, true);
    const again = owner.open();
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.error.code, "already_open");
    // The rejected reopen did not consume an epoch.
    assert.equal(owner.lifecycleEpoch, "1");
  } finally {
    disposeFixture(fixture);
  }
});

test("implements the replay and rate primitives only, on closed vocabulary", () => {
  // The public surface is the lifecycle seam, the write guard, and one
  // command entry point. No primitive gets its own public method.
  const surface = Object.getOwnPropertyNames(
    SharedStateSqliteAdapterV1.prototype,
  ).filter((name) => name !== "constructor");
  assert.deepEqual(surface.sort(), [
    "beginWrite",
    "close",
    "drain",
    "lifecycle",
    "lifecycleEpoch",
    "open",
    "ownerToken",
    "transact",
  ]);

  assert.equal(
    SHARED_STATE_SQLITE_ADAPTER_V1.contractVersion,
    V.versions.contract,
  );
  // Backend class and writer model come from the closed vocabulary.
  assert.equal(
    V.backendClasses.includes(SHARED_STATE_SQLITE_ADAPTER_V1.backendClass),
    true,
  );
  assert.equal(
    V.writerModels.includes(SHARED_STATE_SQLITE_ADAPTER_V1.writerModel),
    true,
  );
  // `ownership_conflict` is reused from the closed lifecycle and readiness
  // vocabulary rather than invented for this adapter.
  assert.equal(V.lifecycleReasonCodes.includes("ownership_conflict"), true);
  assert.equal(V.readinessReasonCodes.includes("ownership_conflict"), true);
  assert.equal(
    new Set(SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1).size,
    SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1.length,
  );
  // `unsafe_clock` is answered as an existing unavailable reason code, not as
  // an adapter-private invention.
  assert.equal(V.unavailableReasonCodes.includes("unsafe_clock"), true);
  assert.equal(
    SHARED_STATE_SQLITE_ADAPTER_ERROR_CODES_V1.includes("unsafe_clock" as never),
    false,
  );
  // The adapter's clock profile is the same closed value as its backend class,
  // so the two cannot drift apart.
  assert.equal(
    SHARED_STATE_SQLITE_ADAPTER_V1.clockProfile,
    SHARED_STATE_SQLITE_ADAPTER_V1.backendClass,
  );
});

test("refuses every operation this slice does not implement", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    // Built by hand rather than parsed: the point is that the adapter refuses
    // on the operation alone, before it looks at anything else.
    const unimplemented = {
      kind: V.kinds.transactionCommand,
      contractVersion: V.versions.contract,
      transactionVersion: V.versions.transaction,
      operationVersion: V.versions.operation,
      operation: "claimLease",
      input: {},
    } as unknown as SharedStateTransactionCommandV1;
    const refused = owner.transact(unimplemented, { observedAtUnixMs: "10" });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.error.code, "operation_not_implemented");
  } finally {
    disposeFixture(fixture);
  }
});

test("a nonce is accepted once and replayed while it is still active", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const first = committed(
      owner.transact(replayCommand({ nonce: "n-1", ttlMs: 1_000 }), {
        observedAtUnixMs: "1000",
      }),
    );
    assert.equal(first.decision, V.operationDecisions.consumeReplayNonce[0]);
    assert.equal(first.expiresInMs, 1_000);

    // Same nonce, same instant.
    const second = committed(
      owner.transact(replayCommand({ nonce: "n-1", ttlMs: 1_000 }), {
        observedAtUnixMs: "1000",
      }),
    );
    assert.equal(second.decision, V.operationDecisions.consumeReplayNonce[1]);
    assert.equal(second.expiresInMs, 1_000);

    // A different nonce under the same requester key is unaffected.
    const other = committed(
      owner.transact(replayCommand({ nonce: "n-2", ttlMs: 1_000 }), {
        observedAtUnixMs: "1000",
      }),
    );
    assert.equal(other.decision, V.operationDecisions.consumeReplayNonce[0]);
  } finally {
    disposeFixture(fixture);
  }
});

test("replay decides at expiry-1, expiry, and expiry+1", () => {
  // The section 2.6 boundary rule is `now < expiresAt`, so the instant of
  // expiry itself is already expired. Each probe uses its own database so one
  // probe's write cannot change another's answer.
  const probes = [
    { observed: "1999", expected: V.operationDecisions.consumeReplayNonce[1] },
    { observed: "2000", expected: V.operationDecisions.consumeReplayNonce[0] },
    { observed: "2001", expected: V.operationDecisions.consumeReplayNonce[0] },
  ] as const;
  for (const probe of probes) {
    const fixture = makeFixture();
    try {
      const owner = readyAdapter(fixture.db);
      assert.equal(
        committed(
          owner.transact(replayCommand({ nonce: "n-1", ttlMs: 1_000 }), {
            observedAtUnixMs: "1000",
          }),
        ).decision,
        V.operationDecisions.consumeReplayNonce[0],
      );
      const again = committed(
        owner.transact(replayCommand({ nonce: "n-1", ttlMs: 1_000 }), {
          observedAtUnixMs: probe.observed,
        }),
      );
      assert.equal(again.decision, probe.expected);
    } finally {
      disposeFixture(fixture);
    }
  }
});

test("rate cost accumulates, refuses over the limit, and frees on window exit", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const spend = (cost: number, at: string): Record<string, unknown> =>
      committed(
        owner.transact(rateCommand({ cost, limit: 10, windowMs: 1_000 }), {
          observedAtUnixMs: at,
        }),
      );

    const first = spend(6, "1000");
    assert.equal(
      first.decision,
      V.operationDecisions.reserveRateLimitCost[0],
    );
    assert.equal(first.remaining, 4);
    assert.equal(first.resetInMs, 1_000);

    const second = spend(4, "1200");
    assert.equal(second.remaining, 0);
    // The window still resets from the oldest counted entry, not from now.
    assert.equal(second.resetInMs, 800);

    const refused = spend(1, "1300");
    assert.equal(
      refused.decision,
      V.operationDecisions.reserveRateLimitCost[1],
    );
    assert.equal(refused.resetInMs, 700);

    // At 2000 the first entry left the window; 2200 frees the second too.
    const partial = spend(6, "2000");
    assert.equal(
      partial.decision,
      V.operationDecisions.reserveRateLimitCost[0],
    );
    assert.equal(partial.remaining, 0);
  } finally {
    disposeFixture(fixture);
  }
});

test("expired rows stay on disk and do not change the decision", () => {
  // Section 2.6 requires physical cleanup delay never to change a logical
  // decision. This asserts the delay is real: the expired rows are still
  // there, and the answer is the same as if they were gone.
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    assert.equal(
      committed(
        owner.transact(rateCommand({ cost: 9, limit: 10, windowMs: 1_000 }), {
          observedAtUnixMs: "1000",
        }),
      ).decision,
      V.operationDecisions.reserveRateLimitCost[0],
    );
    const after = committed(
      owner.transact(rateCommand({ cost: 9, limit: 10, windowMs: 1_000 }), {
        observedAtUnixMs: "5000",
      }),
    );
    assert.equal(after.decision, V.operationDecisions.reserveRateLimitCost[0]);
    assert.equal(after.remaining, 1);

    const rows = fixture.db
      .prepare("SELECT COUNT(*) AS total FROM shared_state_rate_cost")
      .get() as { total?: unknown };
    assert.equal(rows.total, 2);
  } finally {
    disposeFixture(fixture);
  }
});

test("the clock floor advances durably and only inside a committed write", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const floor = (): unknown => {
      const row = fixture.db
        .prepare(
          "SELECT persisted_floor_unix_ms AS f FROM shared_state_clock_floor",
        )
        .get() as { f?: unknown };
      return row.f;
    };
    assert.equal(floor(), "0");
    committed(
      owner.transact(replayCommand({ nonce: "n-1", ttlMs: 1_000 }), {
        observedAtUnixMs: "1000",
      }),
    );
    assert.equal(floor(), "1000");

    // An observation at the floor is safe and requires no floor write.
    committed(
      owner.transact(replayCommand({ nonce: "n-2", ttlMs: 1_000 }), {
        observedAtUnixMs: "1000",
      }),
    );
    assert.equal(floor(), "1000");
  } finally {
    disposeFixture(fixture);
  }
});

test("a backward observation beyond tolerance is unavailable, not a decision", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    committed(
      owner.transact(replayCommand({ nonce: "n-1", ttlMs: 1_000 }), {
        observedAtUnixMs: "5000",
      }),
    );

    const backward = owner.transact(
      replayCommand({ nonce: "n-2", ttlMs: 1_000 }),
      { observedAtUnixMs: "4000" },
    );
    assert.equal(backward.ok, true);
    if (!backward.ok) return;
    assert.equal(backward.value.status, V.transactionStatuses[2]);
    if (backward.value.status !== V.transactionStatuses[2]) return;
    assert.equal(backward.value.reasonCode, "unsafe_clock");
    assert.equal(
      backward.value.completeness,
      V.resultCompletenessStates[1],
    );

    // Writes are forbidden afterwards, and nothing was written.
    const lifecycle = owner.lifecycle();
    assert.equal(lifecycle?.state, "failed");
    const write = owner.beginWrite();
    assert.equal(write.ok, false);
    const rows = fixture.db
      .prepare("SELECT COUNT(*) AS total FROM shared_state_replay_nonce")
      .get() as { total?: unknown };
    assert.equal(rows.total, 1);
  } finally {
    disposeFixture(fixture);
  }
});

test("a command from a session that lost ownership never reaches the store", () => {
  const fixture = makeFixture();
  const second = new DatabaseSync(fixture.path);
  try {
    const first = readyAdapter(fixture.db, "owner-a");
    // Force a takeover behind the holder's back.
    second
      .prepare("UPDATE shared_state_ownership SET owner_token = ? WHERE id = 1")
      .run("owner-b");

    const attempted = first.transact(
      replayCommand({ nonce: "n-1", ttlMs: 1_000 }),
      { observedAtUnixMs: "1000" },
    );
    assert.equal(attempted.ok, false);
    if (attempted.ok) return;
    assert.equal(attempted.error.code, "ownership_lost");

    const rows = fixture.db
      .prepare("SELECT COUNT(*) AS total FROM shared_state_replay_nonce")
      .get() as { total?: unknown };
    assert.equal(rows.total, 0);
  } finally {
    disposeFixture(fixture, [second]);
  }
});
