/**
 * TEST-ONLY write-effect proofs driven through the W1 bounded FIFO worker lane.
 *
 * WHAT THIS ADDS. Decision W6 found that worker targets, holding no raw handle
 * by design, never assert what a command actually left on disk. The inline
 * targets do, through the `DatabaseSync` their fixtures hand them. These are
 * mode-dependent claims — what the worker-owned adapter wrote to the file could
 * differ from what an in-process adapter wrote — so their absence was a
 * coverage gap rather than an exclusion, and W6 listed it as owed.
 *
 * WHY THE PORTS NEEDED ALMOST NOTHING NEW. The closed control set already
 * carries harness-shaped reads of exactly this state: `leaseRows`,
 * `outboxRows`, `idempotencyEffectCounts` and `expirySnapshot` between them
 * cover every assertion here but one. Only the epoch pair was missing, and it
 * was added to `adapterLifecycle` rather than to a new control name, because
 * `partitionState` already returned both values — it is a re-cut of an existing
 * read, not a new reach. No new control name, no generic SELECT, no second
 * main-thread handle.
 *
 * TWO OF W6'S FIVE OWED ITEMS ARE NOT PORTED, AND THAT IS DELIBERATE.
 *
 *   `shared-state-sqlite-outbox-target-v1.test.ts:604` — "allocates every
 *   sequence in the adapter, never in the target" — reads
 *   `SqliteOutboxConformanceTargetV1.prototype.appendOutbox.toString()` and
 *   asserts the source contains no "sequence". It opens no database. W6's own
 *   definition excludes static assertions over source text or a prototype
 *   because they cannot change with execution mode, so W6 listed as a
 *   write-effect gap something it had already excluded two paragraphs earlier.
 *   That is an error in W6, corrected in the W9 record.
 *
 *   `shared-state-sqlite-lease-target-v1.test.ts:810` — "confirms a lease
 *   command writes one row and stages no audit or outbox" — runs no lease
 *   command. Its body opens a bare handle, applies the schema, and reads
 *   `sqlite_master` to show no audit table exists. The worker entry applies the
 *   same schema function to the same file, so the catalog cannot differ by
 *   mode; porting it would need a generic catalog read to prove nothing.
 *
 *   The claim in that test's *title*, however, is genuinely mode-dependent and
 *   was never actually asserted anywhere. It is made here for the first time,
 *   against the durable rows rather than against the schema.
 *
 * What this does NOT do: it checks neither 488 nor 489, and this proves no
 * delayed-or-missing-ACK query case. One of W6's owed items remains after this
 * slice — the Phase 2.5 proofs about the adapter's real state under stress — and
 * whether the ported set satisfies W0's wording is the separate judgment W6
 * describes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SHARED_STATE_EXPIRY_CONFORMANCE_V1 } from "../shared-state-expiry-conformance-v1.js";
import { SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1 } from "../shared-state-sqlite-conformance-control-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateTransactionCommandV1,
  type SharedStateTransactionCommandV1,
} from "../shared-state-storage-contract-v1.js";
import { digestSharedStateKeyV1 } from "../shared-state-storage-keyspace-v1.js";
import {
  createSharedStateSqliteWorkerConformanceSessionV1,
  type SharedStateSqliteWorkerConformanceSessionV1,
} from "../shared-state-sqlite-worker-conformance-session-v1.js";

const REPLAY_NAMESPACE = "security.replay.conformance";
const LEASE_NAMESPACE = "broker.lease.conformance";
const BOUNDARY_MS = SHARED_STATE_EXPIRY_CONFORMANCE_V1.boundaryDurationMs;
const FIRST_INSTANT = 2_000_000;

function probeDigest(
  domain: string,
  namespace: string,
  components: readonly {
    readonly field: string;
    readonly type: "utf8" | "uint" | "bytes";
    readonly value: string;
  }[],
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

function replayCommand(nonce: string): SharedStateTransactionCommandV1 {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "consumeReplayNonce",
    input: {
      namespace: REPLAY_NAMESPACE,
      keyDigest: probeDigest(
        "security.replay.requester-key",
        REPLAY_NAMESPACE,
        [{ field: "requesterId", type: "utf8", value: "retain-requester" }],
      ),
      nonceDigest: probeDigest("security.replay.nonce", REPLAY_NAMESPACE, [
        { field: "nonce", type: "utf8", value: nonce },
      ]),
      ttlMs: BOUNDARY_MS,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

function claimCommand(
  ownerId: string,
  expectedResourceVersion: string,
): SharedStateTransactionCommandV1 {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "claimLease",
    input: {
      namespace: LEASE_NAMESPACE,
      resourceKeyDigest: probeDigest(
        "broker.lease.resource-key",
        LEASE_NAMESPACE,
        [
          { field: "resourceType", type: "utf8", value: "broker-expiry" },
          { field: "resourceId", type: "utf8", value: "expiry-resource" },
        ],
      ),
      ownerKeyDigest: probeDigest("broker.lease.owner-key", LEASE_NAMESPACE, [
        { field: "ownerId", type: "utf8", value: ownerId },
      ]),
      leaseDurationMs: BOUNDARY_MS,
      expectedResourceVersion,
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

interface Harness {
  readonly session: SharedStateSqliteWorkerConformanceSessionV1;
  readonly directory: string;
}

async function openHarness(name: string): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), `shared-state-w9-${name}-`));
  const session = createSharedStateSqliteWorkerConformanceSessionV1({
    filePath: join(directory, "v1.db"),
    ownerToken: "write-effects-owner",
    backwardSkewToleranceMs: "0",
    queueCapacity: 8,
    acknowledgmentTimeoutMs: 30_000,
    drainTimeoutMs: 30_000,
  });
  assert.equal((await session.open()).ok, true);
  return { session, directory };
}

async function disposeHarness(harness: Harness): Promise<void> {
  await harness.session.dispose();
  rmSync(harness.directory, { recursive: true, force: true });
}

/**
 * The worker clock is a queue, not a slot, and an empty queue fails the command
 * closed. Every transact needs exactly one publish immediately before it, in
 * the same step — publishing twice or not at all changes what the command sees
 * rather than failing loudly.
 */
async function transactAt(
  session: SharedStateSqliteWorkerConformanceSessionV1,
  instant: number,
  command: SharedStateTransactionCommandV1,
): Promise<Record<string, unknown>> {
  await session
    .channel()
    .control("setObservedInstant", { observedAtUnixMs: String(instant) });
  const result = await session.lane().transact(command);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.value.status, "committed");
  if (result.value.status !== "committed") throw new Error("unreachable");
  return result.value.result as Record<string, unknown>;
}

async function replayDecisionAt(
  session: SharedStateSqliteWorkerConformanceSessionV1,
  instant: number,
  nonce: string,
): Promise<unknown> {
  return (await transactAt(session, instant, replayCommand(nonce))).decision;
}

// ---------------------------------------------------------------------------

test("a lease command writes exactly one row and stages no outbox or idempotency effect", async () => {
  const harness = await openHarness("lease-effects");
  try {
    const { session } = harness;
    const committed = await transactAt(
      session,
      FIRST_INSTANT,
      claimCommand("write-effects-owner-a", "0"),
    );
    assert.equal(committed.fencingToken, "1");

    // This is the claim the inline test's title makes and its body never did.
    // Asserted against the durable rows, not against the schema catalogue.
    const leaseRows = (await session
      .channel()
      .control("leaseRows")) as readonly Record<string, unknown>[];
    assert.equal(leaseRows.length, 1);
    assert.equal(String(leaseRows[0]!.fencing_token), "1");

    const outboxRows = (await session
      .channel()
      .control("outboxRows")) as readonly unknown[];
    assert.equal(outboxRows.length, 0);

    const effects = (await session
      .channel()
      .control("idempotencyEffectCounts")) as {
      readonly outcomeCount?: unknown;
      readonly linkCount?: unknown;
    };
    assert.equal(Number(effects.outcomeCount), 0);
    assert.equal(Number(effects.linkCount), 0);
  } finally {
    await disposeHarness(harness);
  }
});

test("an expired replay row stays on disk and the expiry instant is exclusive", async () => {
  const harness = await openHarness("replay-retention");
  try {
    const { session } = harness;

    // Same four instants as inline: accept, replay while live, accept exactly
    // at expiry, replay one past it. The middle pair is the exclusive boundary.
    assert.equal(
      await replayDecisionAt(session, FIRST_INSTANT, "retain-1"),
      "accepted",
    );
    assert.equal(
      await replayDecisionAt(session, FIRST_INSTANT + BOUNDARY_MS - 1, "retain-1"),
      "replay",
    );
    assert.equal(
      await replayDecisionAt(session, FIRST_INSTANT + BOUNDARY_MS, "retain-1"),
      "accepted",
    );
    assert.equal(
      await replayDecisionAt(session, FIRST_INSTANT + BOUNDARY_MS + 1, "retain-1"),
      "replay",
    );

    // The on-disk claim: the overwrite never briefly deletes the row, so the
    // count stays one across the exclusive boundary. This is the assertion no
    // worker target could make before, because none holds a raw handle.
    const snapshot = (await session.channel().control("expirySnapshot", {
      observedAtUnixMs: String(FIRST_INSTANT + BOUNDARY_MS + 1),
      physicalCleanupState: "none",
      capacityPressureBand: V.pressureBands[0],
    })) as { readonly replayRetainedCount?: unknown };
    assert.equal(Number(snapshot.replayRetainedCount), 1);
  } finally {
    await disposeHarness(harness);
  }
});

test("ownershipEpoch derives from the lease fence, not the worker session epoch", async () => {
  const harness = await openHarness("epoch-provenance");
  try {
    const { session } = harness;

    const first = await transactAt(
      session,
      FIRST_INSTANT,
      claimCommand("write-effects-owner-a", "0"),
    );
    assert.equal(first.fencingToken, "1");

    const second = await transactAt(
      session,
      FIRST_INSTANT + BOUNDARY_MS + 1,
      claimCommand("write-effects-owner-b", String(first.resourceVersion)),
    );
    assert.equal(second.fencingToken, "2");

    // The fence moved twice. The session did not: a reclaim is a lane transact
    // inside one open session, and the ownership epoch is not sourced from it.
    // Both halves must be checked, or "derives from the fence" is only half
    // said. Keeping this inside one session is load-bearing — a close/reopen
    // would legitimately move the epoch and the assertion would quietly change
    // meaning.
    const reply = (await session.channel().control("adapterLifecycle")) as {
      readonly adapterLifecycleEpoch?: unknown;
      readonly ownershipRowLifecycleEpoch?: unknown;
    };
    assert.equal(String(reply.adapterLifecycleEpoch), "1");
    assert.equal(String(reply.ownershipRowLifecycleEpoch), "1");

    const leaseRows = (await session
      .channel()
      .control("leaseRows")) as readonly Record<string, unknown>[];
    assert.equal(leaseRows.length, 1);
    assert.equal(String(leaseRows[0]!.fencing_token), "2");

    // `ownershipEpoch` is the declared synthesis, literally max(fencing_token).
    // Cross-checking it against the fence is what makes the provenance claim
    // rather than two unrelated numbers that happen to agree.
    const snapshot = (await session.channel().control("expirySnapshot", {
      observedAtUnixMs: String(FIRST_INSTANT + BOUNDARY_MS + 1),
      physicalCleanupState: "none",
      capacityPressureBand: V.pressureBands[0],
    })) as { readonly ownershipEpoch?: unknown };
    assert.equal(String(snapshot.ownershipEpoch), "2");
  } finally {
    await disposeHarness(harness);
  }
});

test("declares the write-effect control inventory and opens no main-thread handle", () => {
  for (const name of [
    "leaseRows",
    "outboxRows",
    "idempotencyEffectCounts",
    "expirySnapshot",
    "adapterLifecycle",
    "setObservedInstant",
  ]) {
    assert.equal(
      SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1.includes(name as never),
      true,
    );
  }

  const source = openHarness.toString() + disposeHarness.toString()
    + transactAt.toString();
  assert.equal(source.includes("DatabaseSync"), false);
  assert.equal(source.includes("prepare("), false);
});
