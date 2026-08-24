/**
 * TEST-ONLY Phase 2.5 conformance target driven through the W1 bounded FIFO
 * worker lane. The last of the seven.
 *
 * DECISION W3 IS WHAT MADE THIS POSSIBLE. Phase 2.5's `timeout` premise needs a
 * second connection holding `RESERVED` so the adapter's own `BEGIN IMMEDIATE`
 * raises a real busy error. W3 placed that rival inside the conformance worker
 * — a bare second `DatabaseSync`, never a second V1 adapter — so the worker
 * stays the single V1 authority for its file and no main-thread handle exists.
 * The other four points were already-solved shapes: two out-of-band updates,
 * one `COMMIT` fault the existing seam fires, and one that establishes nothing.
 *
 * THE SYNCHRONOUS ARM. `armConformanceFault` is typed `: void` and the harness
 * never awaits it, yet in worker mode it has to heal the previous premise,
 * install the new one, and for the two ownership points drive the adapter's own
 * `beginWrite` guard so the premise is genuinely observed. Message ordering
 * makes the work land before the next lane request, but a failure inside it
 * cannot be thrown back at a caller that is already gone. The worker records it
 * and the next awaited control surfaces it — which is where the harness would
 * notice in any case, and is strictly better than losing it.
 *
 * WHAT IS PROVED HERE THAT NO SUBSTITUTE COULD FAKE. Every refusal is a real
 * adapter boundary: `ownership_lost` from the adapter re-reading the ownership
 * row, and `store_failure` from a genuinely busy store or a throwing `COMMIT`.
 * The target asserts which boundary produced each refusal rather than assuming
 * it, exactly as the inline target does.
 *
 * NO MAIN-THREAD BYPASS. This target opens no `DatabaseSync` and holds no raw
 * handle — including the rival, which lives in the worker.
 *
 * What this does NOT do: it checks neither 488 nor 489. Checking 488 is a
 * separate judgment about whether seven passing worker-mode harnesses satisfy
 * "every applicable V1 deterministic conformance/failure suite", and 489 needs
 * focused proof about a delayed or missing earlier durable ACK that nothing
 * here provides.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SHARED_STATE_PARTITION_FAULT_POINTS_V1,
  SHARED_STATE_PARTITION_FAULT_REASONS_V1,
  SharedStatePartitionConformanceErrorV1,
  runSharedStatePartitionConformanceV1,
  sharedStatePartitionConformanceSnapshotV1Schema,
  sharedStatePartitionReadinessV1Schema,
  sharedStatePartitionStaleReadV1Schema,
  type SharedStatePartitionConformanceTargetFactoryV1,
  type SharedStatePartitionConformanceTargetV1,
  type SharedStatePartitionFaultPointV1,
} from "../shared-state-partition-conformance-v1.js";
import { SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1 } from "../shared-state-sqlite-conformance-control-v1.js";
import {
  createSharedStateSqliteWorkerConformanceSessionV1,
  type SharedStateSqliteWorkerConformanceSessionV1,
} from "../shared-state-sqlite-worker-conformance-session-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  type SharedStateTransactionCommandV1,
} from "../shared-state-storage-contract-v1.js";
import { digestSharedStateKeyV1 } from "../shared-state-storage-keyspace-v1.js";

const GRAPH_NAMESPACE = "broker.claim-graph.partition";
const SEEDED_GRAPH_SOURCE_COUNT = 3;

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
  if (!parsed.ok) throw new Error("seed digest refused");
  return parsed.value.digest;
}

const SEED_STREAM_KEY_DIGEST = graphDigest(
  "broker.claim-graph.source-stream-key",
  [
    { field: "sourceType", type: "utf8", value: "run" },
    { field: "sourceId", type: "utf8", value: "partition-seed" },
  ],
);

/**
 * A graph source append, used only to seed provenance inside `open()`.
 * Provenance sources with no projection batch leave the checkpoint at 0 while
 * the high-water mark reaches 3, which is what makes the stale answer's lag a
 * real stored fact rather than a constant.
 */
function seedGraphSourceCommand(
  ordinal: number,
): SharedStateTransactionCommandV1 {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "appendGraphSource",
    input: {
      namespace: GRAPH_NAMESPACE,
      sourceStreamKeyDigest: SEED_STREAM_KEY_DIGEST,
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
  if (!parsed.ok) throw new Error("seed command refused");
  return parsed.value;
}

const SKEW_TOLERANCE_MS = "0";
const LANE_QUEUE_CAPACITY = 256;
const READINESS_VOCABULARY = new Set<string>(V.readinessReasonCodes);

/** Everything worker-mode Phase 2.5 reaches for beyond the lane protocol. */
const PARTITION_CONTROLS_USED_V1 = Object.freeze([
  "partitionArm",
  "partitionEstablish",
  "partitionHeal",
  "partitionState",
  "setObservedInstant",
] as const);

interface AdversarialWorkerPartitionControlV1 {
  readonly skipFaultInjection?: boolean;
  readonly wrongUnavailableReason?: boolean;
  readonly mutateWhileUnavailable?: boolean;
  readonly staleReadNotLabeled?: boolean;
  readonly staysReadyWhilePartitioned?: boolean;
}

interface PartitionStateReplyV1 {
  readonly replayRecordCount: number;
  readonly rateEntryCount: number;
  readonly activeLeaseCount: number;
  readonly maximumFencingToken: string;
  readonly leaseResourceVersion: string;
  readonly idempotencyOutcomeCount: number;
  readonly outboxEventCount: number;
  readonly unacknowledgedEventCount: number;
  readonly acknowledgedEventCount: number;
  readonly streamSequenceHighWater: string;
  readonly provenanceSourceCount: number;
  readonly provenanceSourceHighWater: string;
  readonly provenanceCheckpointSequence: string;
  readonly ownerTokenRow: string | null;
  readonly lifecycleEpochRow: string | null;
  readonly adapterOwnerToken: string;
  readonly adapterLifecycleEpoch: string | null;
  readonly adapterLifecycle: {
    readonly state: string;
    readonly reasonCodes: readonly string[];
  } | null;
  readonly rivalHoldsLock: boolean;
  readonly commitFaultFiredCount: number;
  readonly lastArmError: string | null;
}

function unavailableResult(
  operation: SharedStateTransactionCommandV1["operation"],
  reasonCode: string,
): unknown {
  const consistency = V.operationConsistency[operation];
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    status: "unavailable",
    consistency: { model: consistency.model, scope: consistency.scope },
    completeness: V.resultCompletenessStates[1],
    reasonCode,
  });
  if (!parsed.ok) {
    throw new SharedStatePartitionConformanceErrorV1("invalid_target_result");
  }
  return parsed.value;
}

class WorkerPartitionConformanceTargetV1
implements SharedStatePartitionConformanceTargetV1 {
  readonly #session: SharedStateSqliteWorkerConformanceSessionV1;
  readonly #adversarial: AdversarialWorkerPartitionControlV1;
  readonly #usurperToken: string;
  #armed: SharedStatePartitionFaultPointV1 | null = null;
  /** The harness injects no clock, so the target owns a monotonic counter. */
  #observed = 0;
  readonly #reach = { ownership: 0, busy: 0, commit: 0 };

  constructor(input: {
    readonly session: SharedStateSqliteWorkerConformanceSessionV1;
    readonly adversarial: AdversarialWorkerPartitionControlV1;
    readonly usurperToken: string;
  }) {
    this.#session = input.session;
    this.#adversarial = input.adversarial;
    this.#usurperToken = input.usurperToken;
  }

  /**
   * Reads the worker's view and surfaces any failure the synchronous arm could
   * not throw. Every awaited path goes through here, so a lost premise cannot
   * stay quiet for longer than one control round-trip.
   */
  async #state(): Promise<PartitionStateReplyV1> {
    const state = (await this.#session.observationChannel().control(
      "partitionState",
    )) as PartitionStateReplyV1;
    if (state.lastArmError !== null) {
      throw new Error(`arm failed in worker: ${state.lastArmError}`);
    }
    return state;
  }

  async open(): Promise<unknown> {
    const opened = await this.#session.open();
    if (!opened.ok) throw new Error(`lane open refused: ${opened.error.code}`);
    for (
      let ordinal = 1;
      ordinal <= SEEDED_GRAPH_SOURCE_COUNT;
      ordinal += 1
    ) {
      const seeded = await this.#laneTransact(seedGraphSourceCommand(ordinal));
      if (!seeded.ok) throw new Error(`seed refused: ${seeded.code}`);
    }
    return opened.value;
  }

  async close(): Promise<unknown> {
    await this.#session.observationChannel().control("partitionHeal");
    const closed = await this.#session.close({ toleratesDrainFailure: true });
    if (!closed.ok) throw new Error(`lane close refused: ${closed.error.code}`);
    return closed.value;
  }

  armConformanceFault(
    faultPoint: SharedStatePartitionFaultPointV1 | null,
  ): void {
    if (
      faultPoint !== null
      && !SHARED_STATE_PARTITION_FAULT_POINTS_V1.includes(faultPoint)
    ) {
      throw new Error(`unknown partition fault point: ${faultPoint}`);
    }
    this.#armed = faultPoint;
    // Fire-and-forget by contract. Ordering on the shared port is what makes it
    // land before the next lane request; a failure inside it is recorded by the
    // worker and surfaced by the next awaited control.
    this.#session.channel().send("partitionArm", {
      faultPoint,
      skipFaultInjection: this.#adversarial.skipFaultInjection === true,
      usurperToken: this.#usurperToken,
    });
  }

  /** The adapter error code each armed point must actually produce. */
  #expectedRefusal(
    faultPoint: Exclude<SharedStatePartitionFaultPointV1, "delayed-read">,
  ): string {
    // A busy store and a throwing COMMIT both leave the adapter `ready` with
    // nothing written, and both surface as `store_failure`.
    return faultPoint === "unavailable" || faultPoint === "lost-fence"
      ? "ownership_lost"
      : "store_failure";
  }

  async #laneTransact(
    command: SharedStateTransactionCommandV1,
  ): Promise<
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly code: string }
  > {
    this.#observed += 1;
    this.#session.channel().send("setObservedInstant", {
      observedAtUnixMs: this.#observed.toString(),
    });
    const result = await this.#session.lane().transact(command);
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, code: result.error.code };
  }

  async transact(command: SharedStateTransactionCommandV1): Promise<unknown> {
    const fault = this.#armed;
    if (
      fault === null
      || fault === "delayed-read"
      || this.#adversarial.skipFaultInjection === true
    ) {
      const clean = await this.#laneTransact(command);
      if (!clean.ok) throw new Error(`lane refused: ${clean.code}`);
      return clean.value;
    }

    const reasonCode =
      this.#adversarial.wrongUnavailableReason === true
        ? "authority_unavailable"
        : SHARED_STATE_PARTITION_FAULT_REASONS_V1[fault];

    if (this.#adversarial.mutateWhileUnavailable === true) {
      // Violation: the premise is lifted for the duration of the command, so
      // the write really applies, and the unavailable envelope is a lie about
      // state that moved.
      await this.#session.observationChannel().control("partitionHeal");
      const applied = await this.#laneTransact(command);
      if (!applied.ok) throw new Error(`lane refused: ${applied.code}`);
      return unavailableResult(command.operation, reasonCode);
    }

    if (fault === "unavailable" || fault === "lost-fence") {
      // Re-establish per command rather than leaning on the failed state left
      // by the previous one: every refusal in a level-triggered run is then a
      // fresh ownership check inside the adapter, not a cached verdict.
      const channel = this.#session.observationChannel();
      await channel.control("partitionHeal");
      await channel.control("partitionEstablish", {
        faultPoint: fault,
        usurperToken: this.#usurperToken,
      });
    }

    const before = await this.#state();
    const refused = await this.#laneTransact(command);
    if (refused.ok) {
      throw new Error("armed fault did not reach the adapter");
    }
    const expected = this.#expectedRefusal(fault);
    if (refused.code !== expected) {
      // Any other failure is a real one and is never dressed up as a fault.
      throw new Error(
        `unplanned adapter refusal: ${refused.code} (expected ${expected})`,
      );
    }
    if (fault === "ambiguous-commit") {
      const after = await this.#state();
      if (after.commitFaultFiredCount === before.commitFaultFiredCount) {
        throw new Error("commit fault never fired");
      }
    }
    // Record which real adapter boundary produced this refusal, so the run can
    // assert the seams were reached rather than assume it.
    if (fault === "ambiguous-commit") this.#reach.commit += 1;
    else if (fault === "timeout") this.#reach.busy += 1;
    else this.#reach.ownership += 1;
    return unavailableResult(command.operation, reasonCode);
  }

  /**
   * A real observation, not the armed flag read back: the ownership row is
   * compared against what this adapter session holds. The rival lock is the one
   * component the store cannot report, and it is the worker's own.
   */
  #authorityReachable(state: PartitionStateReplyV1): boolean {
    if (state.rivalHoldsLock) return false;
    return (
      state.ownerTokenRow === state.adapterOwnerToken
      && state.lifecycleEpochRow === state.adapterLifecycleEpoch
    );
  }

  async captureConformanceSnapshot(): Promise<unknown> {
    const state = await this.#state();
    return sharedStatePartitionConformanceSnapshotV1Schema.parse({
      kind: "SharedStatePartitionConformanceSnapshotV1",
      snapshotVersion: 1,
      replayRecordCount: state.replayRecordCount,
      rateEntryCount: state.rateEntryCount,
      activeLeaseCount: state.activeLeaseCount,
      maximumFencingToken: state.maximumFencingToken,
      leaseResourceVersion: state.leaseResourceVersion,
      idempotencyOutcomeCount: state.idempotencyOutcomeCount,
      outboxEventCount: state.outboxEventCount,
      unacknowledgedEventCount: state.unacknowledgedEventCount,
      acknowledgedEventCount: state.acknowledgedEventCount,
      streamSequenceHighWater: state.streamSequenceHighWater,
      provenanceSourceCount: state.provenanceSourceCount,
      provenanceCheckpointSequence: state.provenanceCheckpointSequence,
      // Declared synthesis: V1 implements no retention prune, so there is no
      // durable prune record to count.
      prunedRecordCount: 0,
      authorityReachable: this.#authorityReachable(state),
    });
  }

  async captureConformanceReadiness(): Promise<unknown> {
    const state = await this.#state();
    const envelope = state.adapterLifecycle;
    if (envelope === null) {
      throw new Error("adapter produced no lifecycle envelope");
    }
    const ready =
      this.#adversarial.staysReadyWhilePartitioned === true
        ? true
        : envelope.state === "ready";
    // The synthesized half, cut as narrowly as decision 3(iii) asks: the real
    // lifecycle reasons projected into the readiness vocabulary, nothing
    // invented on top.
    const readinessReasonCodes =
      this.#adversarial.staysReadyWhilePartitioned === true
        ? []
        : envelope.reasonCodes.filter((code) => READINESS_VOCABULARY.has(code));
    return sharedStatePartitionReadinessV1Schema.parse({
      kind: "SharedStatePartitionConformanceReadinessV1",
      readinessVersion: 1,
      scope: "test-only-adapter-lifecycle-readiness-control",
      ready,
      lifecycleState: envelope.state,
      lifecycleReasonCodes: envelope.reasonCodes,
      readinessReasonCodes,
    });
  }

  async readConformanceStaleProjection(): Promise<unknown> {
    const state = await this.#state();
    const checkpoint = BigInt(state.provenanceCheckpointSequence);
    const highWater =
      this.#adversarial.staleReadNotLabeled === true
        ? checkpoint
        : BigInt(state.provenanceSourceHighWater);
    return sharedStatePartitionStaleReadV1Schema.parse({
      kind: "SharedStatePartitionConformanceStaleReadV1",
      staleReadVersion: 1,
      scope: "test-only-partition-conformance-control",
      freshness: "stale",
      // Derived from the two stored sequences, never hard-coded. Only the
      // complete/incomplete split is needed: the harness checks
      // `!== "complete"`, and the unavailable case belongs to Phase 2.7.
      completeness: checkpoint === highWater ? "complete" : "incomplete",
      asOfSourceSequence: checkpoint.toString(),
      checkpointSequence: checkpoint.toString(),
      sourceSequenceHighWater: highWater.toString(),
      lag: Number(highWater - checkpoint),
    });
  }
}

function createWorkerPartitionFixtureV1(
  adversarial: AdversarialWorkerPartitionControlV1 = {},
): {
  readonly factory: SharedStatePartitionConformanceTargetFactoryV1;
  dispose(): Promise<void>;
} {
  const directories: string[] = [];
  const sessions: SharedStateSqliteWorkerConformanceSessionV1[] = [];
  let ordinal = 0;

  const factory: SharedStatePartitionConformanceTargetFactoryV1 = Object.freeze({
    async create(): Promise<SharedStatePartitionConformanceTargetV1> {
      ordinal += 1;
      const directory = mkdtempSync(
        join(tmpdir(), "shared-state-worker-partition-target-v1-"),
      );
      directories.push(directory);

      const session = createSharedStateSqliteWorkerConformanceSessionV1({
        filePath: join(directory, "v1.db"),
        ownerToken: `worker-partition-conformance-owner-${ordinal}`,
        backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
        queueCapacity: LANE_QUEUE_CAPACITY,
        acknowledgmentTimeoutMs: 30_000,
        drainTimeoutMs: 30_000,
      });
      sessions.push(session);

      return new WorkerPartitionConformanceTargetV1({
        session,
        adversarial,
        usurperToken: `worker-partition-usurper-${ordinal}`,
      });
    },
  });

  return {
    factory,
    async dispose(): Promise<void> {
      for (const session of sessions) {
        await session.dispose();
      }
      for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

async function expectWorkerConformanceErrorCode(
  adversarial: AdversarialWorkerPartitionControlV1,
  expected: string,
): Promise<void> {
  const fixture = createWorkerPartitionFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStatePartitionConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStatePartitionConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStatePartitionConformanceErrorV1)) {
          return false;
        }
        assert.equal(error.code, expected);
        return true;
      },
    );
  } finally {
    await fixture.dispose();
  }
}

test("declares the worker-mode Phase 2.5 control inventory", () => {
  for (const control of PARTITION_CONTROLS_USED_V1) {
    assert.equal(
      (SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1 as readonly string[])
        .includes(control),
      true,
      `undeclared control: ${control}`,
    );
  }
  // Decision W3: the rival lives in the worker, so the target holds no handle
  // of its own — not even for the one harness whose subject is contention.
  const source = WorkerPartitionConformanceTargetV1.toString();
  assert.equal(source.includes("DatabaseSync"), false);
  assert.equal(source.includes("prepare("), false);
});

test("runs the Phase 2.5 harness through the V1 SQLite worker lane", async () => {
  const fixture = createWorkerPartitionFixtureV1();
  try {
    const report = await runSharedStatePartitionConformanceV1(fixture.factory);
    assert.equal(report.status, "passed");
    assert.equal(report.contractVersion, V.versions.contract);
  } finally {
    await fixture.dispose();
  }
});

test("serves the stale answer from the worker's stored checkpoint and high-water state", async () => {
  // Decision W6 owed this one. The harness run and the `staleReadNotLabeled`
  // adversarial case both exercise `readConformanceStaleProjection`, but
  // neither asserts the numbers it derives — the first only cares that the run
  // passes, the second only that a lying target is caught. So nothing pinned
  // that the stale answer is built from what the seeded transactions actually
  // committed rather than from constants, which is the mode-dependent part:
  // these sequences came back through the lane from a worker-owned adapter.
  const fixture = createWorkerPartitionFixtureV1();
  try {
    const target = await fixture.factory.create();
    await target.open();
    const stale = (await target.readConformanceStaleProjection()) as {
      readonly completeness?: unknown;
      readonly checkpointSequence?: unknown;
      readonly sourceSequenceHighWater?: unknown;
      readonly asOfSourceSequence?: unknown;
      readonly lag?: unknown;
    };

    // No projection batch is applied during seeding, so the checkpoint is still
    // zero while the sources have advanced. A stale read must say so rather
    // than round the gap away.
    assert.equal(stale.completeness, "incomplete");
    assert.equal(stale.checkpointSequence, "0");
    assert.equal(
      stale.sourceSequenceHighWater,
      String(SEEDED_GRAPH_SOURCE_COUNT),
    );
    assert.equal(stale.asOfSourceSequence, stale.checkpointSequence);
    assert.equal(stale.lag, SEEDED_GRAPH_SOURCE_COUNT);
  } finally {
    await fixture.dispose();
  }
});

test("fails closed on each adversarial partition violation in worker mode", async () => {
  await expectWorkerConformanceErrorCode(
    { skipFaultInjection: true },
    "empty_local_decision",
  );
  await expectWorkerConformanceErrorCode(
    { wrongUnavailableReason: true },
    "unavailable_reason_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { mutateWhileUnavailable: true },
    "mutation_applied_while_unavailable",
  );
  await expectWorkerConformanceErrorCode(
    { staleReadNotLabeled: true },
    "stale_read_not_labeled",
  );
  await expectWorkerConformanceErrorCode(
    { staysReadyWhilePartitioned: true },
    "not_ready_state_mismatch",
  );
});
