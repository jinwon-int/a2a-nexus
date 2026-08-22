/**
 * Tests for the V1 SQLite adapter: lifecycle, ownership, and the replay,
 * rate, lease, and idempotency primitives.
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
 * The lease tests target the two orderings that carry weight rather than the
 * happy path: a contender whose version is ALSO stale must still be told
 * `claim_conflict`, and a superseded fence must be reported before owner,
 * expiry, or version — including when nothing holds the resource, which is
 * what separates comparing against the stored fence from comparing against
 * the active claim. Both cases were found by adversarial controls that passed
 * against an earlier, weaker version of these tests.
 *
 * The idempotency tests do the same for replay: a retry that repeats the key
 * and payload but declares a different effect is the only case that separates
 * returning the stored outcome from re-deriving it, and it too was found by a
 * control that passed first.
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
import {
  digestSharedStateKeyV1,
  parseSharedStateDigestV1,
} from "./shared-state-storage-keyspace-v1.js";

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

const RESOURCE = digest("broker.lease.resource-key", [
  { field: "resourceType", type: "utf8", value: "task" },
  { field: "resourceId", type: "utf8", value: "task-1" },
]);

function ownerDigest(ownerId: string): string {
  return digest("broker.lease.owner-key", [
    { field: "ownerId", type: "utf8", value: ownerId },
  ]);
}

/**
 * The mutation digest binds the kind, so a `checkpoint` digest is not a
 * `complete` digest.
 */
function mutationDigest(kind: string): string {
  return digest("broker.lease.mutation", [
    { field: "mutationKind", type: "utf8", value: kind },
    { field: "mutationBody", type: "bytes", value: "00" },
  ]);
}

function claim(input: {
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

/**
 * The authority a `claimLease` result grants. The three follow-up commands all
 * present exactly this, so tests thread it through instead of restating it.
 */
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

/**
 * Idempotency namespaces are registered, not free-form, so these tests use the
 * catalog's own registration rather than the `broker.test` namespace the other
 * primitives use.
 */
const IDEMPOTENCY_NAMESPACE = "broker.task.create";
const IDEMPOTENCY_RETENTION = "task-create-effects.v1";

function namespacedDigest(
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

function idempotentCommand(input: {
  readonly clientKey?: string;
  readonly payload: string;
  readonly mutation?: string;
}): SharedStateTransactionCommandV1 {
  const namespace = IDEMPOTENCY_NAMESPACE;
  const d = (
    domain: string,
    components: readonly Record<string, unknown>[],
  ): string => namespacedDigest(namespace, domain, components);
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "executeIdempotent",
    input: {
      namespace,
      keyDigest: d("broker.idempotency.key", [
        { field: "operationName", type: "utf8", value: "create-task" },
        {
          field: "clientKey",
          type: "utf8",
          value: input.clientKey ?? "client-1",
        },
      ]),
      payloadFingerprint: d("broker.idempotency.payload-fingerprint", [
        { field: "payload", type: "bytes", value: input.payload },
      ]),
      retentionPolicyVersion: IDEMPOTENCY_RETENTION,
      effect: {
        kind: "domain-mutation-with-outbox",
        domainMutationDigest: d("broker.idempotency.domain-mutation", [
          { field: "mutationType", type: "utf8", value: "create" },
          {
            field: "mutationBody",
            type: "bytes",
            value: input.mutation ?? "aa",
          },
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

function rejected(
  result: ReturnType<SharedStateSqliteAdapterV1["transact"]>,
): string {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, V.transactionStatuses[1]);
  if (result.value.status !== V.transactionStatuses[1]) {
    throw new Error("unreachable");
  }
  return result.value.reasonCode;
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

test("implements the replay, rate, lease, and idempotency primitives", () => {
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
      operation: "appendOutbox",
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

test("a claim binds owner, attempt, and fence, and raises the version", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const claimed = committed(
      owner.transact(
        claim({ owner: "o-1", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
        { observedAtUnixMs: "1000" },
      ),
    );
    assert.equal(claimed.decision, V.operationDecisions.claimLease[0]);
    assert.equal(claimed.fencingToken, "1");
    assert.equal(claimed.resourceVersion, "1");
    assert.equal(claimed.leaseExpiresInMs, 1_000);

    // The attempt key is a real attempt-key digest in this namespace, not an
    // opaque token the adapter made up.
    const parsed = parseSharedStateDigestV1(claimed.attemptKeyDigest, {
      domain: "broker.lease.attempt-key",
      namespace: NAMESPACE,
    });
    assert.equal(parsed.ok, true);
  } finally {
    disposeFixture(fixture);
  }
});

test("a live claim blocks a contender, and version staleness is reported separately", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    committed(
      owner.transact(
        claim({ owner: "o-1", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
        { observedAtUnixMs: "1000" },
      ),
    );

    // A contender with the CORRECT version loses to the live holder.
    assert.equal(
      rejected(
        owner.transact(
          claim({ owner: "o-2", leaseDurationMs: 1_000, expectedResourceVersion: "1" }),
          { observedAtUnixMs: "1500" },
        ),
      ),
      "claim_conflict",
    );

    // The load-bearing case. A contender whose version is ALSO stale — every
    // loser of a barrier race is in exactly this state, because the winner
    // moved the version out from under it — must still be told it lost the
    // resource, not that its version is stale. Checking the version first
    // would answer `version_conflict` here and is what this asserts against.
    assert.equal(
      rejected(
        owner.transact(
          claim({ owner: "o-3", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
          { observedAtUnixMs: "1500" },
        ),
      ),
      "claim_conflict",
    );

    // After expiry the resource is claimable, but a stale version is now the
    // reason it fails.
    assert.equal(
      rejected(
        owner.transact(
          claim({ owner: "o-2", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
          { observedAtUnixMs: "2000" },
        ),
      ),
      "version_conflict",
    );
  } finally {
    disposeFixture(fixture);
  }
});

test("the fence never decreases across expiry, takeover, and release", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const first = committed(
      owner.transact(
        claim({ owner: "o-1", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
        { observedAtUnixMs: "1000" },
      ),
    );
    assert.equal(first.fencingToken, "1");

    // Let it expire, then take over.
    const second = committed(
      owner.transact(
        claim({ owner: "o-2", leaseDurationMs: 1_000, expectedResourceVersion: "1" }),
        { observedAtUnixMs: "2000" },
      ),
    );
    assert.equal(second.fencingToken, "2");
    assert.equal(second.resourceVersion, "2");
    assert.notEqual(second.attemptKeyDigest, first.attemptKeyDigest);

    // Release, then claim again: the fence resumes above, it does not reset.
    const authority = authorityOf("o-2", second);
    committed(
      owner.transact(
        authorityCommand("releaseLease", authority, { releaseKind: "release" }),
        { observedAtUnixMs: "2100" },
      ),
    );
    const third = committed(
      owner.transact(
        claim({ owner: "o-3", leaseDurationMs: 1_000, expectedResourceVersion: "3" }),
        { observedAtUnixMs: "2200" },
      ),
    );
    assert.equal(third.fencingToken, "3");
  } finally {
    disposeFixture(fixture);
  }
});

test("a superseded holder is fenced out before anything else is considered", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const first = committed(
      owner.transact(
        claim({ owner: "o-1", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
        { observedAtUnixMs: "1000" },
      ),
    );
    const stale = authorityOf("o-1", first);

    // o-1 expires and o-2 takes over.
    committed(
      owner.transact(
        claim({ owner: "o-2", leaseDurationMs: 1_000, expectedResourceVersion: "1" }),
        { observedAtUnixMs: "2000" },
      ),
    );

    // o-1 now holds fence 1 while the resource is at fence 2. Every command
    // it can issue is `stale_fence` — it never learns about the new holder.
    for (
      const attempt of [
        authorityCommand("renewLease", stale, { leaseDurationMs: 1_000 }),
        authorityCommand("mutateWithFence", stale, {
          mutationKind: "checkpoint",
          mutationDigest: mutationDigest("checkpoint"),
        }),
        authorityCommand("releaseLease", stale, { releaseKind: "release" }),
      ]
    ) {
      assert.equal(
        rejected(owner.transact(attempt, { observedAtUnixMs: "2100" })),
        "stale_fence",
      );
    }

    // And nothing it tried changed the resource version.
    const row = fixture.db
      .prepare(
        "SELECT resource_version AS v FROM shared_state_lease LIMIT 1",
      )
      .get() as { v?: unknown };
    assert.equal(row.v, "2");
  } finally {
    disposeFixture(fixture);
  }
});

test("renew extends the lease, and expiry is judged at the exact instant", () => {
  // `expiry` itself is already expired, matching the section 2.6 rule.
  const probes = [
    { observed: "1999", expected: "renewed" },
    { observed: "2000", expected: "lease_expired" },
  ] as const;
  for (const probe of probes) {
    const fixture = makeFixture();
    try {
      const owner = readyAdapter(fixture.db);
      const first = committed(
        owner.transact(
          claim({ owner: "o-1", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
          { observedAtUnixMs: "1000" },
        ),
      );
      const authority = authorityOf("o-1", first);
      const renewal = owner.transact(
        authorityCommand("renewLease", authority, { leaseDurationMs: 500 }),
        { observedAtUnixMs: probe.observed },
      );
      if (probe.expected === "renewed") {
        const result = committed(renewal);
        assert.equal(result.decision, V.operationDecisions.renewLease[0]);
        assert.equal(result.resourceVersion, "2");
      } else {
        assert.equal(rejected(renewal), "lease_expired");
      }
    } finally {
      disposeFixture(fixture);
    }
  }
});

test("a checkpoint mutation keeps the claim; any other kind ends it", () => {
  for (const kind of V.leaseMutationKinds) {
    const fixture = makeFixture();
    try {
      const owner = readyAdapter(fixture.db);
      const first = committed(
        owner.transact(
          claim({ owner: "o-1", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
          { observedAtUnixMs: "1000" },
        ),
      );
      const authority = authorityOf("o-1", first);
      const applied = committed(
        owner.transact(
          authorityCommand("mutateWithFence", authority, {
            mutationKind: kind,
            mutationDigest: mutationDigest(kind),
          }),
          { observedAtUnixMs: "1100" },
        ),
      );
      assert.equal(applied.decision, V.operationDecisions.mutateWithFence[0]);
      assert.equal(applied.resourceVersion, "2");

      const row = fixture.db
        .prepare(
          "SELECT attempt_key_digest AS a FROM shared_state_lease LIMIT 1",
        )
        .get() as { a?: unknown };
      if (kind === "checkpoint") {
        assert.equal(row.a, authority.attemptKeyDigest);
      } else {
        // A terminal mutation ends the claim, so the resource is immediately
        // claimable again without waiting for the lease to expire.
        assert.equal(row.a, null);
        const retaken = committed(
          owner.transact(
            claim({ owner: "o-2", leaseDurationMs: 1_000, expectedResourceVersion: "2" }),
            { observedAtUnixMs: "1200" },
          ),
        );
        assert.equal(retaken.fencingToken, "2");
      }
    } finally {
      disposeFixture(fixture);
    }
  }
});

test("release works after expiry, but not twice", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const first = committed(
      owner.transact(
        claim({ owner: "o-1", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
        { observedAtUnixMs: "1000" },
      ),
    );
    const authority = authorityOf("o-1", first);

    // Well past expiry. Releasing is how a holder cleans up after itself, so
    // it must still be allowed.
    const released = committed(
      owner.transact(
        authorityCommand("releaseLease", authority, { releaseKind: "release" }),
        { observedAtUnixMs: "9000" },
      ),
    );
    assert.equal(released.decision, V.operationDecisions.releaseLease[0]);
    assert.equal(released.resourceVersion, "2");

    // A second release has no claim to end. It is a state-transition error,
    // not an expiry one.
    assert.equal(
      rejected(
        owner.transact(
          authorityCommand("releaseLease", authority, { releaseKind: "release" }),
          { observedAtUnixMs: "9100" },
        ),
      ),
      "invalid_state_transition",
    );

    // Once somebody else claims, the released holder's fence is superseded.
    // It must now be told `stale_fence` rather than `invalid_state_transition`:
    // the fence is compared against the stored high-water mark, which release
    // did not lower, not against the (absent) active claim.
    const second = committed(
      owner.transact(
        claim({ owner: "o-2", leaseDurationMs: 1_000, expectedResourceVersion: "2" }),
        { observedAtUnixMs: "9200" },
      ),
    );
    // o-2 releases too, so there is no active claim at all — only a fence
    // high-water mark of 2. This is the state that separates "compare against
    // the stored fence" from "compare against the active claim".
    committed(
      owner.transact(
        authorityCommand("releaseLease", authorityOf("o-2", second), {
          releaseKind: "release",
        }),
        { observedAtUnixMs: "9250" },
      ),
    );
    assert.equal(
      rejected(
        owner.transact(
          authorityCommand("releaseLease", authority, { releaseKind: "release" }),
          { observedAtUnixMs: "9300" },
        ),
      ),
      "stale_fence",
    );
  } finally {
    disposeFixture(fixture);
  }
});

test("the right holder with the wrong owner or version is refused distinctly", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const first = committed(
      owner.transact(
        claim({ owner: "o-1", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
        { observedAtUnixMs: "1000" },
      ),
    );
    const authority = authorityOf("o-1", first);

    assert.equal(
      rejected(
        owner.transact(
          authorityCommand(
            "renewLease",
            { ...authority, owner: "o-2" },
            { leaseDurationMs: 500 },
          ),
          { observedAtUnixMs: "1100" },
        ),
      ),
      "owner_mismatch",
    );
    assert.equal(
      rejected(
        owner.transact(
          authorityCommand(
            "renewLease",
            { ...authority, expectedResourceVersion: "0" },
            { leaseDurationMs: 500 },
          ),
          { observedAtUnixMs: "1100" },
        ),
      ),
      "version_conflict",
    );

    // A forged attempt key with the right fence is still stale, not an owner
    // mismatch: the attempt binding is checked first.
    assert.equal(
      rejected(
        owner.transact(
          authorityCommand(
            "renewLease",
            {
              ...authority,
              attemptKeyDigest: digest("broker.lease.attempt-key", [
                { field: "resourceId", type: "utf8", value: "forged" },
                { field: "attemptNumber", type: "uint", value: "1" },
              ]),
            },
            { leaseDurationMs: 500 },
          ),
          { observedAtUnixMs: "1100" },
        ),
      ),
      "stale_fence",
    );

    // None of the three refusals moved the resource.
    const row = fixture.db
      .prepare("SELECT resource_version AS v FROM shared_state_lease LIMIT 1")
      .get() as { v?: unknown };
    assert.equal(row.v, "1");
  } finally {
    disposeFixture(fixture);
  }
});

test("leases in different namespaces and resources do not interfere", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const other = digest("broker.lease.resource-key", [
      { field: "resourceType", type: "utf8", value: "task" },
      { field: "resourceId", type: "utf8", value: "task-2" },
    ]);
    committed(
      owner.transact(
        claim({ owner: "o-1", leaseDurationMs: 1_000, expectedResourceVersion: "0" }),
        { observedAtUnixMs: "1000" },
      ),
    );
    // A different resource is unclaimed, so it starts at version 0 and takes
    // its own fence — the reference model is single-resource, the adapter
    // is not.
    const second = committed(
      owner.transact(
        command("claimLease", {
          resourceKeyDigest: other,
          ownerKeyDigest: ownerDigest("o-2"),
          leaseDurationMs: 1_000,
          expectedResourceVersion: "0",
        }),
        { observedAtUnixMs: "1000" },
      ),
    );
    assert.equal(second.fencingToken, "1");
    assert.equal(second.resourceVersion, "1");
  } finally {
    disposeFixture(fixture);
  }
});

test("a keyed effect executes once and then replays the identical outcome", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const first = committed(
      owner.transact(idempotentCommand({ payload: "a1" }), {
        observedAtUnixMs: "1000",
      }),
    );
    assert.equal(first.decision, V.operationDecisions.executeIdempotent[0]);
    const parsed = parseSharedStateDigestV1(first.outcomeDigest, {
      domain: "broker.idempotency.outcome",
      namespace: IDEMPOTENCY_NAMESPACE,
    });
    assert.equal(parsed.ok, true);

    // A retry much later still replays, and returns the same outcome byte for
    // byte. There is no TTL: the registered namespaces are non-expiring until
    // an authorized prune, so time must not change this answer.
    const second = committed(
      owner.transact(idempotentCommand({ payload: "a1" }), {
        observedAtUnixMs: "999000",
      }),
    );
    assert.equal(second.decision, V.operationDecisions.executeIdempotent[1]);
    assert.equal(second.outcomeDigest, first.outcomeDigest);

    // The load-bearing case for "returns the STORED outcome". A retry that
    // repeats the key and the payload but declares a different mutation would
    // derive a different outcome, so re-deriving on replay and returning the
    // stored value give different answers here — and only the stored value is
    // correct. The first execution is what happened; a later caller does not
    // get to restate it.
    const drifted = committed(
      owner.transact(
        idempotentCommand({ payload: "a1", mutation: "ff" }),
        { observedAtUnixMs: "999100" },
      ),
    );
    assert.equal(drifted.decision, V.operationDecisions.executeIdempotent[1]);
    assert.equal(drifted.outcomeDigest, first.outcomeDigest);

    // Exactly one record, not two.
    const rows = fixture.db
      .prepare("SELECT COUNT(*) AS total FROM shared_state_idempotency")
      .get() as { total?: unknown };
    assert.equal(rows.total, 1);
  } finally {
    disposeFixture(fixture);
  }
});

test("the same key with a different payload is a conflict, and writes nothing", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const first = committed(
      owner.transact(idempotentCommand({ payload: "a1" }), {
        observedAtUnixMs: "1000",
      }),
    );

    // Reusing a key for different work is the one thing idempotency must
    // never absorb: it would report success for work that never happened.
    assert.equal(
      rejected(
        owner.transact(idempotentCommand({ payload: "b1" }), {
          observedAtUnixMs: "1100",
        }),
      ),
      "idempotency_conflict",
    );

    const row = fixture.db
      .prepare(
        `SELECT payload_fingerprint AS p, outcome_digest AS o
           FROM shared_state_idempotency`,
      )
      .get() as { p?: unknown; o?: unknown };
    assert.equal(row.o, first.outcomeDigest);
    // The stored fingerprint is still the original one.
    assert.equal(
      row.p,
      namespacedDigest(
        IDEMPOTENCY_NAMESPACE,
        "broker.idempotency.payload-fingerprint",
        [{ field: "payload", type: "bytes", value: "a1" }],
      ),
    );
  } finally {
    disposeFixture(fixture);
  }
});

test("a different key under the same namespace executes on its own", () => {
  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);
    const first = committed(
      owner.transact(idempotentCommand({ payload: "a1" }), {
        observedAtUnixMs: "1000",
      }),
    );
    const other = committed(
      owner.transact(
        idempotentCommand({ clientKey: "client-2", payload: "a1" }),
        { observedAtUnixMs: "1000" },
      ),
    );
    assert.equal(other.decision, V.operationDecisions.executeIdempotent[0]);
    // Same declared mutation, so the derived outcome is the same value — the
    // outcome is bound to the effect, not to the key.
    assert.equal(other.outcomeDigest, first.outcomeDigest);

    // A different mutation derives a different outcome.
    const changed = committed(
      owner.transact(
        idempotentCommand({
          clientKey: "client-3",
          payload: "a1",
          mutation: "cc",
        }),
        { observedAtUnixMs: "1000" },
      ),
    );
    assert.notEqual(changed.outcomeDigest, first.outcomeDigest);
  } finally {
    disposeFixture(fixture);
  }
});

test("the adapter re-checks the idempotency catalog the parser already gates", () => {
  // `parseSharedStateTransactionCommandV1` already refuses an unregistered
  // namespace (`unknown_idempotency_namespace`) and a mismatched retention
  // policy (`idempotency_retention_policy_mismatch`), so neither can reach the
  // adapter through a parsed command. These commands are therefore built by
  // hand: the adapter's own catalog check is defence in depth, and this
  // asserts it fails closed rather than trusting its caller.
  const handBuilt = (
    namespace: string,
    retentionPolicyVersion: string,
  ): SharedStateTransactionCommandV1 => {
    const d = (
      domain: string,
      components: readonly Record<string, unknown>[],
    ): string => namespacedDigest(namespace, domain, components);
    return {
      kind: V.kinds.transactionCommand,
      contractVersion: V.versions.contract,
      transactionVersion: V.versions.transaction,
      operationVersion: V.versions.operation,
      operation: "executeIdempotent",
      input: {
        namespace,
        keyDigest: d("broker.idempotency.key", [
          { field: "operationName", type: "utf8", value: "create-task" },
          { field: "clientKey", type: "utf8", value: "client-1" },
        ]),
        payloadFingerprint: d("broker.idempotency.payload-fingerprint", [
          { field: "payload", type: "bytes", value: "a1" },
        ]),
        retentionPolicyVersion,
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
    } as unknown as SharedStateTransactionCommandV1;
  };

  const fixture = makeFixture();
  try {
    const owner = readyAdapter(fixture.db);

    // A registered namespace carrying another namespace's retention policy
    // has a rejection reason code, so it is a decision.
    assert.equal(
      rejected(
        owner.transact(
          handBuilt(IDEMPOTENCY_NAMESPACE, "task-wake-effects.v1"),
          { observedAtUnixMs: "1000" },
        ),
      ),
      "retention_policy_mismatch",
    );

    // An unregistered namespace has none. Answering a rejection the contract
    // vocabulary does not contain would be inventing one, so this is an
    // adapter failure instead.
    const unregistered = owner.transact(
      handBuilt("broker.test", IDEMPOTENCY_RETENTION),
      { observedAtUnixMs: "1000" },
    );
    assert.equal(unregistered.ok, false);
    if (unregistered.ok) return;
    assert.equal(
      unregistered.error.code,
      "unregistered_idempotency_namespace",
    );

    // Neither refusal wrote anything.
    const rows = fixture.db
      .prepare("SELECT COUNT(*) AS total FROM shared_state_idempotency")
      .get() as { total?: unknown };
    assert.equal(rows.total, 0);
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
