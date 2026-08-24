/**
 * TEST-ONLY Phase 2.7 conformance target driven through the W1 bounded FIFO
 * worker lane.
 *
 * WHAT THIS ADDS OVER W2a THROUGH W2c
 * Phase 2.7 is the first harness whose out-of-band surface is *derived* state
 * rather than stored state. Its snapshot and its evidence-path probe both
 * compute over the same live batches, checkpoint, and source high-water mark,
 * and the derivation — which batches count, what completeness means, whether a
 * negative judgment is permitted — is the thing under test. So worker mode
 * fetches that state once through one `claimGraphState` control and does every
 * derivation on the main thread, exactly where the inline target does it. Two
 * reads would let the snapshot and the probe disagree about the projection,
 * which is precisely the confusion this harness exists to catch.
 *
 * It is also the first harness where a target-owned flag, not a database row,
 * carries part of the answer: `authorityUnavailable` is set when an injected
 * fault rolls a batch back and cleared by the next clean command. That flag
 * stays on the main thread. Moving it into the worker would have made the
 * `authorityStaysAvailableAfterFault` violation unreachable, because the worker
 * has no way to know a target chose to lie about it.
 *
 * NO MAIN-THREAD BYPASS. This target opens no `DatabaseSync` and holds no raw
 * handle.
 *
 * What this does NOT do: it checks neither 488 nor 489, and this proves no
 * delayed-or-missing-ACK query case. It also does not re-prove where in the
 * statement stream the seam fires — the inline target asserts that against its
 * own `preparedSql` log, and it is a property of the adapter's SQL order rather
 * than of the lane. Decision W6 recorded what does remain
 * inline only: the write-effect assertions no worker target can make while it
 * holds no raw handle, and the Phase 2.5 proofs about the adapter's real state
 * under stress. Whether the ported set satisfies W0's wording is the separate
 * judgment W6 describes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SharedStateClaimGraphConformanceErrorV1,
  runSharedStateClaimGraphConformanceV1,
  sharedStateClaimGraphConformanceSnapshotV1Schema,
  sharedStateClaimGraphEvidenceResultV1Schema,
  type SharedStateClaimGraphConformanceEvidenceQueryV1,
  type SharedStateClaimGraphConformanceTargetFactoryV1,
  type SharedStateClaimGraphConformanceTargetV1,
  type SharedStateClaimGraphFaultPointV1,
} from "../shared-state-claim-graph-conformance-v1.js";
import {
  SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1,
  type SharedStateSqliteConformanceFaultPlanV1,
} from "../shared-state-sqlite-conformance-control-v1.js";
import {
  createSharedStateSqliteWorkerConformanceSessionV1,
  type SharedStateSqliteWorkerConformanceSessionV1,
} from "../shared-state-sqlite-worker-conformance-session-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateTransactionResultV1,
  type SharedStateTransactionCommandV1,
} from "../shared-state-storage-contract-v1.js";

const OBSERVED_AT_UNIX_MS = "1000";
const CHECKPOINT_WRITE_SQL_FRAGMENT =
  "INSERT INTO shared_state_graph_projection";
const SKEW_TOLERANCE_MS = "0";
const LANE_QUEUE_CAPACITY = 256;

/** Everything worker-mode Phase 2.7 reaches for beyond the lane protocol. */
const CLAIM_GRAPH_CONTROLS_USED_V1 = Object.freeze([
  "armFault",
  "claimGraphState",
  "readFaultState",
  "setObservedInstant",
] as const);

/**
 * The seam maps one fault point onto one statement. A fault point added to the
 * vocabulary later must not silently inherit that mapping.
 */
function faultPlanFor(
  faultPoint: SharedStateClaimGraphFaultPointV1,
): SharedStateSqliteConformanceFaultPlanV1 {
  if (faultPoint !== "after-node-edge-writes-before-checkpoint") {
    throw new Error(`unmapped claim-graph fault point: ${faultPoint}`);
  }
  return {
    point: faultPoint,
    sqlFragment: CHECKPOINT_WRITE_SQL_FRAGMENT,
    phase: "before-prepare",
    repeating: false,
  };
}

interface AdversarialWorkerClaimGraphControlV1 {
  readonly deriveIncludingRolledBackBatches?: boolean;
  readonly skipFaultInjection?: boolean;
  readonly authorityStaysAvailableAfterFault?: boolean;
}

interface ClaimGraphStateReplyV1 {
  readonly batches: readonly {
    readonly from: string;
    readonly through: string;
    readonly rolledBack: boolean;
  }[];
  readonly sourceFactCount: number;
  readonly sourceSequenceHighWater: string;
  readonly checkpointSequence: string;
}

interface FaultStateReplyV1 {
  readonly firedAt: readonly string[];
}

interface BatchV1 {
  readonly from: bigint;
  readonly through: bigint;
  readonly rolledBack: boolean;
}

function unavailableResult(
  operation: SharedStateTransactionCommandV1["operation"],
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
    reasonCode: "authority_unavailable",
  });
  if (!parsed.ok) {
    throw new SharedStateClaimGraphConformanceErrorV1("invalid_target_result");
  }
  return parsed.value;
}

class WorkerClaimGraphConformanceTargetV1
implements SharedStateClaimGraphConformanceTargetV1 {
  readonly #session: SharedStateSqliteWorkerConformanceSessionV1;
  readonly #adversarial: AdversarialWorkerClaimGraphControlV1;
  /**
   * Target-owned, deliberately not in the worker. The worker cannot know that
   * a target chose to keep reporting an available authority after a fault, so
   * moving this across would make that violation unreachable.
   */
  #authorityUnavailable = false;
  #seenFiredCount = 0;

  constructor(input: {
    readonly session: SharedStateSqliteWorkerConformanceSessionV1;
    readonly adversarial: AdversarialWorkerClaimGraphControlV1;
  }) {
    this.#session = input.session;
    this.#adversarial = input.adversarial;
  }

  async #firedCount(): Promise<number> {
    const state = (await this.#session.channel().control(
      "readFaultState",
    )) as FaultStateReplyV1;
    return state.firedAt.length;
  }

  async #state(): Promise<ClaimGraphStateReplyV1> {
    return (await this.#session.channel().control(
      "claimGraphState",
    )) as ClaimGraphStateReplyV1;
  }

  #batches(state: ClaimGraphStateReplyV1): readonly BatchV1[] {
    return state.batches.map((batch) => ({
      from: BigInt(batch.from),
      through: BigInt(batch.through),
      rolledBack:
        this.#adversarial.deriveIncludingRolledBackBatches === true
          ? false
          : batch.rolledBack,
    }));
  }

  #completeness(
    state: ClaimGraphStateReplyV1,
  ): "complete" | "incomplete" | "unavailable" {
    if (this.#authorityUnavailable) return "unavailable";
    return state.checkpointSequence === state.sourceSequenceHighWater
      ? "complete"
      : "incomplete";
  }

  async open(): Promise<unknown> {
    const opened = await this.#session.open();
    if (!opened.ok) throw new Error(`lane open refused: ${opened.error.code}`);
    return opened.value;
  }

  /** `close` releases ownership only after drain, so drain runs first. */
  async close(): Promise<unknown> {
    const closed = await this.#session.close();
    if (!closed.ok) throw new Error(`lane close refused: ${closed.error.code}`);
    return closed.value;
  }

  async transact(command: SharedStateTransactionCommandV1): Promise<unknown> {
    this.#session.channel().send("setObservedInstant", {
      observedAtUnixMs: OBSERVED_AT_UNIX_MS,
    });
    const result = await this.#session.lane().transact(command);

    const firedCount = await this.#firedCount();
    if (firedCount > this.#seenFiredCount) {
      this.#seenFiredCount = firedCount;
      // The adapter rolled its own transaction back. Reporting that as an
      // unavailable authority is the target's translation into the harness
      // vocabulary, not an invented outcome: nothing was written.
      if (this.#adversarial.authorityStaysAvailableAfterFault !== true) {
        this.#authorityUnavailable = true;
      }
      return unavailableResult(command.operation);
    }

    // Any other failure is a real one and is never dressed up as a fault.
    if (!result.ok) throw new Error(`lane refused: ${result.error.code}`);

    // A command that completed with no injected fault is the clean retry:
    // the authority is reachable again.
    this.#authorityUnavailable = false;
    return result.value;
  }

  armConformanceProjectionFault(
    faultPoint: SharedStateClaimGraphFaultPointV1,
  ): void {
    const plan = faultPlanFor(faultPoint);
    if (this.#adversarial.skipFaultInjection === true) return;
    // Posted on the same port as the lane request that follows, so it is armed
    // before that request executes even though the harness never awaits this.
    this.#session.channel().send("armFault", plan);
  }

  async captureConformanceSnapshot(): Promise<unknown> {
    const state = await this.#state();
    const batches = this.#batches(state);
    const live = batches.filter((batch) => !batch.rolledBack);

    // One node per sequence in the range, one edge from the first sequence to
    // each later one. Rollback removes a batch's effects rather than
    // tombstoning them, so no tombstone state exists to count.
    let nodeCount = 0;
    let edgeCount = 0;
    for (const batch of live) {
      nodeCount += Number(batch.through - batch.from) + 1;
      edgeCount += Number(batch.through - batch.from);
    }

    return sharedStateClaimGraphConformanceSnapshotV1Schema.parse({
      kind: "SharedStateClaimGraphConformanceSnapshotV1",
      snapshotVersion: 1,
      sourceFactCount: state.sourceFactCount,
      sourceSequenceHighWater: state.sourceSequenceHighWater,
      nodeCount,
      edgeCount,
      tombstonedEdgeCount: 0,
      appliedBatchCount: live.length,
      rolledBackBatchCount: batches.length - live.length,
      checkpointSequence: state.checkpointSequence,
      completeness: this.#completeness(state),
      authorityState: this.#authorityUnavailable
        ? "unavailable"
        : "available",
    });
  }

  async evaluateConformanceEvidencePath(
    query: SharedStateClaimGraphConformanceEvidenceQueryV1,
  ): Promise<unknown> {
    const state = await this.#state();
    const completeness = this.#completeness(state);
    const checkpoint = BigInt(state.checkpointSequence);
    const highWater = BigInt(state.sourceSequenceHighWater);
    const claim = BigInt(query.claimOrdinal);
    const evidenceSequence = BigInt(query.evidenceOrdinal);

    // A batch contributes the edge `from -> evidence` when the evidence
    // sequence is a later member of the same range.
    const supportingEdgeCount = this.#batches(state).filter(
      (batch) =>
        !batch.rolledBack
        && batch.from === claim
        && evidenceSequence > batch.from
        && evidenceSequence <= batch.through,
    ).length;

    let result: string;
    if (completeness === "unavailable") {
      result = "projection_unavailable";
    } else if (supportingEdgeCount > 0) {
      result = "path_found";
    } else if (completeness === "complete") {
      // Spec 5.6 permits the negative judgment only at a complete checkpoint.
      result = "no_evidence_path";
    } else {
      result = "projection_incomplete";
    }

    const lag = Number(highWater - checkpoint);
    return sharedStateClaimGraphEvidenceResultV1Schema.parse({
      kind: "SharedStateClaimGraphConformanceEvidenceResultV1",
      resultVersion: 1,
      scope: "test-only-claim-graph-conformance-control",
      result,
      completeness,
      asOfSourceSequence: checkpoint.toString(),
      checkpointSequence: checkpoint.toString(),
      sourceSequenceHighWater: highWater.toString(),
      lag: lag < 0 ? 0 : lag,
      supportingEdgeCount,
    });
  }
}

function createWorkerClaimGraphFixtureV1(
  adversarial: AdversarialWorkerClaimGraphControlV1 = {},
): {
  readonly factory: SharedStateClaimGraphConformanceTargetFactoryV1;
  dispose(): Promise<void>;
} {
  const directories: string[] = [];
  const sessions: SharedStateSqliteWorkerConformanceSessionV1[] = [];
  let ordinal = 0;

  const factory: SharedStateClaimGraphConformanceTargetFactoryV1 =
    Object.freeze({
      async create(): Promise<SharedStateClaimGraphConformanceTargetV1> {
        ordinal += 1;
        const directory = mkdtempSync(
          join(tmpdir(), "shared-state-worker-claim-graph-target-v1-"),
        );
        directories.push(directory);

        const session = createSharedStateSqliteWorkerConformanceSessionV1({
          filePath: join(directory, "v1.db"),
          ownerToken: `worker-claim-graph-conformance-owner-${ordinal}`,
          backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
          queueCapacity: LANE_QUEUE_CAPACITY,
          acknowledgmentTimeoutMs: 30_000,
          drainTimeoutMs: 30_000,
        });
        sessions.push(session);

        return new WorkerClaimGraphConformanceTargetV1({
          session,
          adversarial,
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
  adversarial: AdversarialWorkerClaimGraphControlV1,
  expected: string,
): Promise<void> {
  const fixture = createWorkerClaimGraphFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStateClaimGraphConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStateClaimGraphConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStateClaimGraphConformanceErrorV1)) {
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

test("declares the worker-mode Phase 2.7 control inventory and fault mapping", () => {
  for (const control of CLAIM_GRAPH_CONTROLS_USED_V1) {
    assert.equal(
      (SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1 as readonly string[])
        .includes(control),
      true,
      `undeclared control: ${control}`,
    );
  }
  const plan = faultPlanFor("after-node-edge-writes-before-checkpoint");
  assert.equal(plan.sqlFragment, CHECKPOINT_WRITE_SQL_FRAGMENT);
  assert.equal(plan.repeating, false);
  // An unmapped point must be refused rather than silently inheriting the one
  // mapping this harness has.
  assert.throws(() =>
    faultPlanFor(
      "some-later-fault-point" as SharedStateClaimGraphFaultPointV1,
    ),
  );
  // The target reaches the database only through the worker.
  const source = WorkerClaimGraphConformanceTargetV1.toString();
  assert.equal(source.includes("DatabaseSync"), false);
  assert.equal(source.includes("prepare("), false);
});

test("runs the Phase 2.7 harness through the V1 SQLite worker lane", async () => {
  const fixture = createWorkerClaimGraphFixtureV1();
  try {
    const report = await runSharedStateClaimGraphConformanceV1(
      fixture.factory,
    );
    assert.equal(report.status, "passed");
    assert.equal(report.contractVersion, V.versions.contract);
  } finally {
    await fixture.dispose();
  }
});

test("fails closed on each adversarial claim-graph violation in worker mode", async () => {
  await expectWorkerConformanceErrorCode(
    { deriveIncludingRolledBackBatches: true },
    "rollback_restoration_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { skipFaultInjection: true },
    "checkpoint_advanced_on_fault",
  );
  await expectWorkerConformanceErrorCode(
    { authorityStaysAvailableAfterFault: true },
    "evidence_path_mismatch",
  );
});
