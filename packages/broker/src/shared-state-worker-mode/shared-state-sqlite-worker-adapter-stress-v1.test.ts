/**
 * TEST-ONLY proofs about the adapter's REAL state under stress, driven through
 * the W1 bounded FIFO worker lane.
 *
 * WHAT THIS ADDS, AND WHY THE HARNESS RUN IS NOT ALREADY IT. Decision W6's last
 * owed item. The worker partition target passes the Phase 2.5 harness and
 * carries five adversarial controls, but every one of those controls asserts
 * that `runSharedStatePartitionConformanceV1` throws a named code when the
 * target lies. That proves the harness is honest. It does not prove the adapter
 * behaved, and the three inline proofs it leaves behind are exactly the ones
 * about behaviour: a real `SQLITE_BUSY` rather than a mapped constant, an armed
 * fault that keeps firing rather than being consumed once, and a genuinely
 * failed lifecycle rather than a target that merely reports not-ready.
 *
 * WHY EVERY READING GOES THROUGH `partitionState`. Reading the target's own
 * `captureConformanceReadiness()` would restate the harness: the envelope it
 * returns is the target's word. `partitionState` reads the raw connection and
 * `adapter.lifecycle()` inside the worker, so it is a second witness
 * independent of the object under test. That distinction is the whole content
 * of W6's finding, reappearing one level down.
 *
 * `commitFaultFiredCount` IS `firedAt.length` — every fault point, not just
 * commits. An exact delta off it is only safe in a file where one point is ever
 * armed, which is why these tests arm `ambiguous-commit` and nothing else, and
 * why `disarmFault` (which clears `firedAt`) is deliberately not used.
 *
 * ONLY `ambiguous-commit` CAN DEMONSTRATE LEVEL-TRIGGERING. The worker target
 * re-establishes the `unavailable` and `lost-fence` points per command, so a
 * one-shot arm would still satisfy the harness's arm-once-refuse-four-times
 * requirement for those two. Only the commit point rides the repeating plan, so
 * a level-trigger proof written against anything else proves nothing.
 *
 * RECOVERY IS PROVED BY A COMMITTED WRITE, NEVER BY A LIFECYCLE READ.
 * `partitionHeal` calls `open()` on a failed adapter, so a `ready` read taken
 * after healing is a fact about the heal rather than about the partition
 * lifting — the same class of error as W9's same-owner reclaim, which still
 * advanced the fence and so made that mutation worthless. Likewise the
 * still-`ready` reading in the busy case is taken while the rival is provably
 * still holding the lock, not after it is released.
 *
 * NO MAIN-THREAD BYPASS. This file opens no `DatabaseSync` and holds no raw
 * handle. The rival writer is Decision W3's second bare connection living
 * inside the conformance worker, taken and released through the existing
 * `partitionEstablish` and `partitionHeal` controls. No new control name, no
 * generic SELECT.
 *
 * What this does NOT do: it checks neither 488 nor 489, and it proves no
 * delayed-or-missing-ACK query case. With this slice W6's owed list is empty,
 * but whether the ported set satisfies W0's wording is the separate judgment W6
 * describes, and W6 said it should not be taken by a slice that benefits from
 * the answer.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

const GRAPH_NAMESPACE = "broker.claim-graph.stress";
const OWNER_TOKEN = "adapter-stress-owner";

/**
 * `partitionEstablish` requires a usurper token even for `timeout`, which does
 * not use it. Keeping an obviously fake constant here means a copy into the
 * ownership point cannot silently turn that test into a no-op.
 */
const UNUSED_RIVAL_TOKEN = "unused-by-the-timeout-point";
const USURPER_TOKEN = "adapter-stress-usurper";

function graphDigest(
  domain:
    | "broker.claim-graph.source-stream-key"
    | "broker.claim-graph.source-fact",
  components: readonly {
    readonly field: string;
    readonly type: "utf8" | "bytes";
    readonly value: string;
  }[],
): string {
  const parsed = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace: GRAPH_NAMESPACE,
    components,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value.digest;
}

const STREAM_KEY_DIGEST = graphDigest(
  "broker.claim-graph.source-stream-key",
  [
    { field: "sourceType", type: "utf8", value: "run" },
    { field: "sourceId", type: "utf8", value: "adapter-stress" },
  ],
);

function appendCommand(ordinal: number): SharedStateTransactionCommandV1 {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "appendGraphSource",
    input: {
      namespace: GRAPH_NAMESPACE,
      sourceStreamKeyDigest: STREAM_KEY_DIGEST,
      sourceFactDigest: graphDigest("broker.claim-graph.source-fact", [
        { field: "nodeType", type: "utf8", value: "Claim" },
        {
          field: "fact",
          type: "bytes",
          value: `25${ordinal.toString(16).padStart(2, "0")}`,
        },
      ]),
      nodeType: "Claim",
      expectedSourceSequence: String(ordinal - 1),
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

interface PartitionStateReply {
  readonly rivalHoldsLock?: unknown;
  readonly commitFaultFiredCount?: unknown;
  readonly lastArmError?: unknown;
  readonly ownerTokenRow?: unknown;
  readonly adapterOwnerToken?: unknown;
  readonly adapterLifecycle?: {
    readonly state?: unknown;
    readonly reasonCodes?: readonly unknown[];
  } | null;
}

interface Harness {
  readonly session: SharedStateSqliteWorkerConformanceSessionV1;
  readonly directory: string;
}

async function openHarness(name: string): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), `shared-state-w10-${name}-`));
  const session = createSharedStateSqliteWorkerConformanceSessionV1({
    filePath: join(directory, "v1.db"),
    ownerToken: OWNER_TOKEN,
    backwardSkewToleranceMs: "0",
    queueCapacity: 8,
    acknowledgmentTimeoutMs: 30_000,
    drainTimeoutMs: 30_000,
  });
  assert.equal((await session.open()).ok, true);
  return { session, directory };
}

async function disposeHarness(harness: Harness): Promise<void> {
  // Heal first: these tests deliberately end with a fault armed or the rival
  // holding RESERVED, and a worker torn down under either would leave the
  // release unclaimed. `dispose` rather than `close` for the same W0 reason the
  // other ported files use it.
  try {
    await harness.session.channel().control("partitionHeal");
  } catch {
    // Teardown must not mask the assertion that already failed.
  }
  await harness.session.dispose();
  rmSync(harness.directory, { recursive: true, force: true });
}

async function readState(
  session: SharedStateSqliteWorkerConformanceSessionV1,
): Promise<PartitionStateReply> {
  return (await session
    .channel()
    .control("partitionState")) as PartitionStateReply;
}

/**
 * The worker clock is a queue that fails closed when empty, so every command
 * needs exactly one publish immediately before it, in the same step.
 */
async function transactAt(
  session: SharedStateSqliteWorkerConformanceSessionV1,
  instant: number,
  ordinal: number,
): Promise<{ readonly ok: boolean; readonly code: string | null }> {
  await session
    .channel()
    .control("setObservedInstant", { observedAtUnixMs: String(instant) });
  const result = await session.lane().transact(appendCommand(ordinal));
  if (result.ok) {
    return { ok: true, code: null };
  }
  return { ok: false, code: result.error.code };
}

/**
 * A lane that refused admission answers without reaching the adapter. On the
 * transact path it cannot forge `ok:false`, but it can forge the *recovery*
 * legs, which are the assertions that make these proofs mean anything.
 */
function assertNothingRefusedAdmission(
  session: SharedStateSqliteWorkerConformanceSessionV1,
): void {
  assert.equal(session.lane().diagnostics().refusedAdmissions, 0);
}

// ---------------------------------------------------------------------------

test("a real rival lock refuses the write while the adapter stays ready, and service returns when it lifts", async () => {
  const harness = await openHarness("busy");
  try {
    const { session } = harness;

    await session.channel().control("partitionEstablish", {
      faultPoint: "timeout",
      usurperToken: UNUSED_RIVAL_TOKEN,
    });

    // The premise itself must be checked. `takeRivalLock` is a no-op when the
    // flag is already set, so without this the refusal below could be some
    // other `store_failure` entirely.
    const armed = await readState(session);
    assert.equal(armed.rivalHoldsLock, true);

    // `store_failure` is the adapter-level truth. `lock_timeout` is the
    // harness's mapped reason, and asserting that would re-prove the mapping
    // rather than the collision.
    const refused = await transactAt(session, 1_001, 1);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "store_failure");

    // Taken while the rival provably still holds the lock. Read after healing
    // it would be a fact about the heal, since `partitionHeal` reopens.
    const during = await readState(session);
    assert.equal(during.rivalHoldsLock, true);
    assert.equal(during.adapterLifecycle?.state, "ready");

    // A successful `partitionState` round-trip while RESERVED is held is also
    // the inline observation that reads are unaffected: the collision is on the
    // write lock.

    await session.channel().control("partitionHeal");

    // Recovery is a committed write, never a lifecycle read.
    const recovered = await transactAt(session, 1_002, 1);
    assert.equal(recovered.ok, true);
    assertNothingRefusedAdmission(session);
  } finally {
    await disposeHarness(harness);
  }
});

test("an armed commit fault keeps firing across every following command and stops when disarmed", async () => {
  const harness = await openHarness("level-trigger");
  try {
    const { session } = harness;

    const before = Number((await readState(session)).commitFaultFiredCount);

    // `ambiguous-commit` is the only point that rides the repeating plan. The
    // ownership points are re-established per command by the target, so they
    // would satisfy an arm-once-refuse-many shape without level-triggering.
    await session.channel().control("partitionArm", {
      faultPoint: "ambiguous-commit",
      skipFaultInjection: false,
      usurperToken: UNUSED_RIVAL_TOKEN,
    });

    for (const attempt of [1, 2, 3]) {
      const result = await transactAt(session, 2_000 + attempt, attempt);
      assert.equal(result.ok, false);
      assert.equal(result.code, "store_failure");
    }

    // Exact equality, not a lower bound. `> before` would pass under a one-shot
    // arm that fired on the first command only, which is precisely the case
    // this test exists to exclude.
    const after = await readState(session);
    assert.equal(Number(after.commitFaultFiredCount), before + 3);

    await session.channel().control("partitionHeal");

    // Disarming is proved by a commit landing, not by reading the fault flag
    // back. The adapter is `ready` throughout an ambiguous-commit fault, so a
    // lifecycle read here would be true whether or not the disarm worked.
    const restored = await transactAt(session, 2_100, 1);
    assert.equal(restored.ok, true);
    assertNothingRefusedAdmission(session);
  } finally {
    await disposeHarness(harness);
  }
});

test("a withdrawn ownership row drives the adapter itself into a failed lifecycle", async () => {
  const harness = await openHarness("failed-lifecycle");
  try {
    const { session } = harness;

    await session.channel().control("partitionArm", {
      faultPoint: "unavailable",
      skipFaultInjection: false,
      usurperToken: USURPER_TOKEN,
    });

    const during = await readState(session);

    // `partitionArm` drives `beginWrite` so the adapter observes the foreign
    // row rather than merely having one written behind it. `lastArmError` is
    // the designed-in loud failure if that never happened.
    assert.equal(during.lastArmError, null);

    // Both halves. `lost-fence` collapses to the same lifecycle and reason, so
    // without pinning the ownership row this could not claim it established the
    // `unavailable` premise specifically rather than some ownership premise.
    assert.equal(during.ownerTokenRow, USURPER_TOKEN);
    assert.notEqual(during.ownerTokenRow, during.adapterOwnerToken);

    // Read from `partitionState`, which is `adapter.lifecycle()` inside the
    // worker — not from the target's own readiness capture, which is the
    // target's word and would restate the adversarial control.
    assert.equal(during.adapterLifecycle?.state, "failed");
    assert.deepEqual(during.adapterLifecycle?.reasonCodes, [
      "adapter_unavailable",
    ]);

    await session.channel().control("partitionHeal");

    const recovered = await transactAt(session, 3_001, 1);
    assert.equal(recovered.ok, true);
    assertNothingRefusedAdmission(session);
  } finally {
    await disposeHarness(harness);
  }
});

test("declares the adapter-stress control inventory and opens no main-thread handle", () => {
  for (const name of [
    "partitionEstablish",
    "partitionArm",
    "partitionHeal",
    "partitionState",
    "setObservedInstant",
  ]) {
    assert.equal(
      SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1.includes(name as never),
      true,
    );
  }

  const source = openHarness.toString() + disposeHarness.toString()
    + transactAt.toString() + readState.toString();
  assert.equal(source.includes("DatabaseSync"), false);
  assert.equal(source.includes("prepare("), false);
});
