/**
 * TEST-ONLY Phase 2.4 conformance target driven through the W1 bounded FIFO
 * worker lane.
 *
 * WHAT THIS ADDS OVER W2a THROUGH W2d
 * Phase 2.4 is the first harness that crashes a target and reopens it without a
 * close of its own, and the first that compares whole snapshots across a
 * restart by JSON string. Both put pressure on the lane's lifecycle rather than
 * on its transaction path.
 *
 * ONE READ, ONE SNAPSHOT. The snapshot, the cursor, and the reconciliation are
 * all derived from a single `restartContinuityState` control. That matters more
 * here than in earlier slices: the harness compares snapshots taken before and
 * after a restart by JSON string, so a snapshot assembled from several reads
 * taken at different moments could differ from itself for reasons that have
 * nothing to do with continuity.
 *
 * WHERE WORKER MODE AND INLINE GENUINELY DIVERGE. After the forbidden
 * backward-clock write the adapter is failed, and `drain` legitimately refuses.
 * The inline target simply closes anyway, releasing ownership. Decision W0 does
 * not permit that here: `close` may ask the worker-owned adapter to release
 * ownership only after a successful drain. So this target tears the worker down
 * without claiming ownership was released, and the following reopen re-acquires
 * with the same owner token — which is what an unclean shutdown followed by a
 * restart actually looks like. The lane's stricter rule is kept rather than
 * relaxed to match the inline path.
 *
 * NO MAIN-THREAD BYPASS. This target opens no `DatabaseSync` and holds no raw
 * handle. The clock-floor read that shapes the unsafe-clock lifecycle answer
 * travels over the control channel like every other observation; the policy
 * evaluation itself is pure and stays on the main thread.
 *
 * What this does NOT do: it checks neither 488 nor 489, and this proves no
 * delayed-or-missing-ACK query case. It also does not re-prove that the two
 * statement crash points fire at their declared positions — the inline target
 * asserts that against its own `preparedSql` log, and it is a property of the
 * adapter's SQL order rather than of the lane. Decision W6 recorded what does remain
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
  SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1,
  SharedStateRestartContinuityConformanceErrorV1,
  runSharedStateRestartContinuityConformanceV1,
  type SharedStateRestartContinuityConformanceClockV1,
  type SharedStateRestartContinuityConformanceCursorV1,
  type SharedStateRestartContinuityConformanceTargetFactoryV1,
  type SharedStateRestartContinuityConformanceTargetV1,
  type SharedStateRestartContinuityFaultPointV1,
} from "../shared-state-restart-continuity-conformance-v1.js";
import { SHARED_STATE_SQLITE_ADAPTER_V1 } from "../shared-state-sqlite-adapter-v1.js";
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
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionResultV1,
  type SharedStateTransactionCommandV1,
} from "../shared-state-storage-contract-v1.js";
import {
  SHARED_STATE_TIME_V1_VALUES as TIME_V,
  evaluateSharedStateTimeV1,
} from "../shared-state-time-v1.js";

const COMMIT_SQL = "COMMIT";
const IDEMPOTENCY_LINK_WRITE_SQL_FRAGMENT =
  "INSERT INTO shared_state_idempotency_outbox_link";
const SKEW_TOLERANCE_MS = "0";
const LANE_QUEUE_CAPACITY = 256;

/** Everything worker-mode Phase 2.4 reaches for beyond the lane protocol. */
const RESTART_CONTROLS_USED_V1 = Object.freeze([
  "armFault",
  "readFaultState",
  "restartContinuityState",
  "setObservedInstant",
] as const);

/**
 * Maps each armed crash point onto its real position. The two `before-` points
 * are statements; the two `after-` points are deliberately not, because the
 * transaction has to commit for the answer to be ambiguous.
 */
function faultPlanFor(
  faultPoint: SharedStateRestartContinuityFaultPointV1,
): SharedStateSqliteConformanceFaultPlanV1 | null {
  switch (faultPoint) {
    case "before-command-commit":
      return {
        point: faultPoint,
        sqlFragment: IDEMPOTENCY_LINK_WRITE_SQL_FRAGMENT,
        phase: "before-prepare",
        repeating: false,
      };
    case "before-ack-commit":
      return {
        point: faultPoint,
        sqlFragment: COMMIT_SQL,
        phase: "before-exec",
        repeating: false,
      };
    case "after-command-commit-before-response":
    case "after-ack-commit-before-response":
      // Not a statement fault: the transaction must genuinely commit and only
      // the response is lost.
      return null;
    default:
      throw new Error(`unknown restart fault point: ${String(faultPoint)}`);
  }
}

interface AdversarialWorkerRestartControlV1 {
  readonly skipFaultInjection?: boolean;
  readonly ambiguousCommitRollsBack?: boolean;
  readonly reopenLosesState?: boolean;
  readonly staysReadyOnUnsafeClock?: boolean;
  readonly ignoreReconcileCursor?: boolean;
  readonly doubleCountDomainEffects?: boolean;
}

interface OutboxStateRowV1 {
  readonly stream_key_digest: string;
  readonly stream_sequence: string;
  readonly receipt_state: string;
  readonly acknowledgment_state: string;
}

interface RestartStateReplyV1 {
  readonly outboxRows: readonly OutboxStateRowV1[];
  readonly leaseRows: readonly {
    readonly attempt_key_digest: string | null;
    readonly fencing_token: string;
    readonly resource_version: string;
  }[];
  readonly rateRows: readonly { readonly cost: number }[];
  readonly graphSourceRows: readonly { readonly source_sequence: string }[];
  readonly projectionRows: readonly {
    readonly checkpoint_sequence: string;
  }[];
  readonly replayRecordCount: number;
  readonly idempotencyCount: number;
  readonly linkCount: number;
  readonly graphBatchCount: number;
  readonly persistedFloorUnixMs: string | null;
}

interface FaultStateReplyV1 {
  readonly firedAt: readonly string[];
}

function maxDecimal(values: readonly string[]): string {
  let highest = 0n;
  for (const value of values) {
    const parsed = BigInt(value);
    if (parsed > highest) highest = parsed;
  }
  return highest.toString();
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
    throw new SharedStateRestartContinuityConformanceErrorV1(
      "invalid_target_result",
    );
  }
  return parsed.value;
}

function synthesizedLifecycle(
  state: (typeof V.lifecycleStates)[number],
  reasonCodes: readonly (typeof V.lifecycleReasonCodes)[number][],
): unknown {
  const parsed = parseSharedStateStorageLifecycleV1({
    kind: V.kinds.lifecycle,
    lifecycleVersion: V.versions.lifecycle,
    contractVersion: V.versions.contract,
    state,
    reasonCodes,
  });
  if (!parsed.ok) {
    throw new SharedStateRestartContinuityConformanceErrorV1(
      "invalid_target_lifecycle",
    );
  }
  return parsed.value;
}

class WorkerRestartContinuityTargetV1
implements SharedStateRestartContinuityConformanceTargetV1 {
  readonly #session: SharedStateSqliteWorkerConformanceSessionV1;
  readonly #clock: SharedStateRestartContinuityConformanceClockV1;
  readonly #adversarial: AdversarialWorkerRestartControlV1;
  #armedAmbiguousCommit: SharedStateRestartContinuityFaultPointV1 | null = null;
  #seenFiredCount = 0;

  constructor(input: {
    readonly session: SharedStateSqliteWorkerConformanceSessionV1;
    readonly clock: SharedStateRestartContinuityConformanceClockV1;
    readonly adversarial: AdversarialWorkerRestartControlV1;
  }) {
    this.#session = input.session;
    this.#clock = input.clock;
    this.#adversarial = input.adversarial;
  }

  #observed(): string {
    return this.#clock.readObservedUnixMilliseconds().toString();
  }

  async #state(): Promise<RestartStateReplyV1> {
    // Observation must survive a crash: the harness snapshots between a crash
    // and the reopen that follows it.
    return (await this.#session.observationChannel().control(
      "restartContinuityState",
    )) as RestartStateReplyV1;
  }

  async #firedCount(): Promise<number> {
    const state = (await this.#session.observationChannel().control(
      "readFaultState",
    )) as FaultStateReplyV1;
    return state.firedAt.length;
  }

  /**
   * Evaluates the persisted floor exactly as `transact` would. The read travels
   * over the control channel; the evaluation is pure and stays here. This is
   * the synthesis decision 3 permits, and it shapes only the lifecycle answer —
   * the adapter is still opened for real.
   */
  #clockIsUnsafe(persistedFloorUnixMs: string | null): boolean {
    if (persistedFloorUnixMs === null) return false;
    const profile = SHARED_STATE_SQLITE_ADAPTER_V1.clockProfile;
    const requirements = TIME_V.profileRequirements[profile];
    const evaluation = evaluateSharedStateTimeV1(
      {
        kind: TIME_V.kinds.policy,
        timeVersion: TIME_V.version,
        clockProfile: profile,
        clockAuthority: requirements.clockAuthority,
        observationSource: requirements.observationSource,
        timestampUnit: TIME_V.timestampUnit,
        integerEncoding: TIME_V.integerEncoding,
        backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
      },
      {
        kind: TIME_V.kinds.observation,
        timeVersion: TIME_V.version,
        trustBoundary: TIME_V.trustBoundary,
        clockProfile: profile,
        clockAuthority: requirements.clockAuthority,
        observationSource: requirements.observationSource,
        observedAtUnixMs: this.#observed(),
        persistedFloorUnixMs,
        // A fresh lifecycle has observed nothing yet, exactly as the adapter
        // resets its own expectation on open.
        minimumExpectedFloorUnixMs: null,
      },
    );
    return !evaluation.ok || !evaluation.value.safe;
  }

  async open(): Promise<unknown> {
    const opened = await this.#session.open();
    if (!opened.ok) throw new Error(`lane open refused: ${opened.error.code}`);
    const state = await this.#state();
    if (
      this.#clockIsUnsafe(state.persistedFloorUnixMs)
      && this.#adversarial.staysReadyOnUnsafeClock !== true
    ) {
      // Declared synthesis, narrowed: the lane is genuinely open, so the
      // forbidden write that follows reaches the adapter and rolls back for
      // real.
      return synthesizedLifecycle("failed", ["unsafe_clock"]);
    }
    return opened.value;
  }

  async close(): Promise<unknown> {
    const closed = await this.#session.close();
    if (closed.ok) {
      if (this.#adversarial.reopenLosesState === true) {
        // Violation: the reopened worker binds to a fresh database, so
        // everything committed before the close is silently gone.
        this.#session.rebindFilePathForViolation(
          join(
            mkdtempSync(join(tmpdir(), "shared-state-worker-restart-lost-")),
            "v1.db",
          ),
        );
      }
      return closed.value;
    }

    // The adapter is failed after the forbidden backward-clock write, so drain
    // refuses. Decision W0 does not let `close` release ownership without a
    // successful drain, so this is an unclean shutdown: tear the worker down
    // and let the reopen re-acquire with the same owner token. The lifecycle
    // reported here is synthesized because no adapter answered one.
    await this.#session.crashForConformance();
    if (this.#adversarial.reopenLosesState === true) {
      this.#session.rebindFilePathForViolation(
        join(
          mkdtempSync(join(tmpdir(), "shared-state-worker-restart-lost-")),
          "v1.db",
        ),
      );
    }
    return synthesizedLifecycle("closed", ["close_requested"]);
  }

  armConformanceCrashFault(
    faultPoint: SharedStateRestartContinuityFaultPointV1,
  ): void {
    if (
      !SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1.includes(faultPoint)
    ) {
      throw new Error(`unknown restart fault point: ${faultPoint}`);
    }
    if (this.#adversarial.skipFaultInjection === true) return;
    const plan = faultPlanFor(faultPoint);
    if (plan === null) {
      this.#armedAmbiguousCommit = faultPoint;
      return;
    }
    this.#session.channel().send("armFault", plan);
  }

  async transact(command: SharedStateTransactionCommandV1): Promise<unknown> {
    if (this.#armedAmbiguousCommit !== null) {
      this.#armedAmbiguousCommit = null;
      if (this.#adversarial.ambiguousCommitRollsBack === true) {
        // Violation: the caller is told the commit is ambiguous while nothing
        // was written, so a retry would apply a second effect.
        await this.#session.crashForConformance();
        return unavailableResult(command.operation, "ambiguous_commit");
      }
      this.#session.channel().send("setObservedInstant", {
        observedAtUnixMs: this.#observed(),
      });
      const committed = await this.#session.lane().transact(command);
      if (!committed.ok) {
        throw new Error(`lane refused: ${committed.error.code}`);
      }
      // The transaction really committed. Only the answer is lost.
      await this.#session.crashForConformance();
      return unavailableResult(command.operation, "ambiguous_commit");
    }

    this.#session.channel().send("setObservedInstant", {
      observedAtUnixMs: this.#observed(),
    });
    const result = await this.#session.lane().transact(command);

    const firedCount = await this.#firedCount();
    if (firedCount > this.#seenFiredCount) {
      this.#seenFiredCount = firedCount;
      // The adapter rolled its own transaction back. Nothing was written.
      await this.#session.crashForConformance();
      return unavailableResult(command.operation, "authority_unavailable");
    }

    if (!result.ok) throw new Error(`lane refused: ${result.error.code}`);

    // An unsafe observation fails the adapter itself: it rolls back, marks
    // itself failed, and refuses everything after. The lane cannot see that —
    // the refusal arrives as a perfectly ordinary `unavailable` result value,
    // not as a lane error — so the lane would keep believing it is ready and
    // answer the harness's next `open` with `already_open`. Tearing the worker
    // down here is the honest worker-mode equivalent of the inline adapter
    // being left failed: what follows a failed authority is a restart.
    if (
      result.value.status === "unavailable"
      && result.value.reasonCode === "unsafe_clock"
    ) {
      await this.#session.crashForConformance();
    }
    return result.value;
  }

  /**
   * Stream ordinals are assigned by sorting the stored digests, so the same
   * stream keeps the same ordinal across a close and reopen. The harness
   * matches high-waters by ordinal, so an unstable order would read as a
   * regression.
   */
  #streamOrdinals(rows: readonly OutboxStateRowV1[]): readonly string[] {
    return [...new Set(rows.map((row) => row.stream_key_digest))].sort(
      (left, right) => left.localeCompare(right),
    );
  }

  async captureConformanceSnapshot(): Promise<unknown> {
    const state = await this.#state();
    const rows = state.outboxRows;
    const count = (predicate: (row: OutboxStateRowV1) => boolean): number =>
      rows.filter(predicate).length;
    const ordinals = this.#streamOrdinals(rows);

    // Key order matches the schema exactly: the harness compares snapshots by
    // JSON string, so order is part of the comparison.
    return Object.freeze({
      kind: "SharedStateRestartContinuityConformanceSnapshotV1",
      snapshotVersion: 1,
      replayRecordCount: state.replayRecordCount,
      rateWindowEntryCount: state.rateRows.length,
      accumulatedRateCost: state.rateRows.reduce(
        (sum, row) => sum + row.cost,
        0,
      ),
      activeLeaseCount: state.leaseRows.filter(
        (row) => row.attempt_key_digest !== null,
      ).length,
      // `fencing_token` is TEXT, so SQL MAX() would sort lexically and rank
      // "9" above "10". The comparison is done in BigInt instead.
      maximumFencingToken: maxDecimal(
        state.leaseRows.map((row) => row.fencing_token),
      ),
      leaseResourceVersionHighWater: maxDecimal(
        state.leaseRows.map((row) => row.resource_version),
      ),
      // Declared synthesis: no durable source exists. See the descriptor.
      leaseMutationCount: 0,
      idempotencyOutcomeCount: state.idempotencyCount,
      // Collapsed onto the idempotency row, as Phase 2.2 and 2.3 declared.
      domainEffectCount:
        this.#adversarial.doubleCountDomainEffects === true
          ? state.idempotencyCount + state.linkCount
          : state.idempotencyCount,
      // NOT collapsed: the outbox link is its own table and its own row.
      idempotentOutboxEffectCount: state.linkCount,
      outboxEventCount: rows.length,
      receiptPendingCount: count((row) => row.receipt_state === "pending"),
      receiptConfirmedCount: count((row) => row.receipt_state === "confirmed"),
      unacknowledgedCount: count(
        (row) => row.acknowledgment_state === "unacknowledged",
      ),
      acknowledgedCount: count(
        (row) => row.acknowledgment_state === "acknowledged",
      ),
      streamHighWaters: ordinals.map((digest, index) => ({
        streamOrdinal: index + 1,
        sequenceHighWater: maxDecimal(
          rows
            .filter((row) => row.stream_key_digest === digest)
            .map((row) => row.stream_sequence),
        ),
      })),
      graphSourceFactCount: state.graphSourceRows.length,
      graphSourceSequenceHighWater: maxDecimal(
        state.graphSourceRows.map((row) => row.source_sequence),
      ),
      graphProjectionBatchCount: state.graphBatchCount,
      graphProjectionCheckpointHighWater: maxDecimal(
        state.projectionRows.map((row) => row.checkpoint_sequence),
      ),
    });
  }

  async captureConformanceCursor(): Promise<unknown> {
    const state = await this.#state();
    const rows = state.outboxRows;
    const ordinals = this.#streamOrdinals(rows);
    return Object.freeze({
      kind: "SharedStateRestartContinuityConformanceCursorV1",
      cursorVersion: 1,
      scope: "test-only-restart-continuity-conformance-control",
      positions: ordinals.map((digest, index) => {
        const forStream = rows
          .filter((row) => row.stream_key_digest === digest)
          .sort((left, right) =>
            BigInt(left.stream_sequence) < BigInt(right.stream_sequence)
              ? -1
              : 1
          );
        let highest = 0n;
        for (const row of forStream) {
          const sequence = BigInt(row.stream_sequence);
          if (sequence > highest) highest = sequence;
        }
        // The acknowledged position is the contiguous acknowledged prefix,
        // not a count of acknowledged rows: one gap ends it.
        let acknowledgedThrough = 0n;
        for (const row of forStream) {
          if (row.acknowledgment_state !== "acknowledged") break;
          acknowledgedThrough = BigInt(row.stream_sequence);
        }
        return {
          streamOrdinal: index + 1,
          afterSequence: highest.toString(),
          acknowledgedThroughSequence: acknowledgedThrough.toString(),
        };
      }),
    });
  }

  async reconcileForConformance(
    cursor: SharedStateRestartContinuityConformanceCursorV1,
  ): Promise<unknown> {
    const state = await this.#state();
    const rows = state.outboxRows;
    const ordinals = this.#streamOrdinals(rows);
    const events: Record<string, unknown>[] = [];
    // `eventRank` runs globally across streams, not per stream.
    let rank = 0;
    for (const position of cursor.positions) {
      const digest = ordinals[position.streamOrdinal - 1];
      if (digest === undefined) continue;
      const after = BigInt(position.afterSequence);
      const acknowledged = BigInt(position.acknowledgedThroughSequence);
      const floor = after > acknowledged ? after : acknowledged;
      const forStream = rows
        .filter((row) => row.stream_key_digest === digest)
        .filter((row) => {
          if (this.#adversarial.ignoreReconcileCursor === true) {
            // The acknowledgment filter has to be dropped along with the
            // floor. At the point the harness reconciles, the only event above
            // the floor is also the only unacknowledged one, so a control that
            // dropped the floor alone returned exactly the right answer and
            // never reached the check it exists to fail.
            return true;
          }
          if (row.acknowledgment_state !== "unacknowledged") return false;
          return BigInt(row.stream_sequence) > floor;
        })
        .sort((left, right) =>
          BigInt(left.stream_sequence) < BigInt(right.stream_sequence) ? -1 : 1
        );
      for (const row of forStream) {
        rank += 1;
        events.push({
          eventRank: rank,
          streamOrdinal: position.streamOrdinal,
          streamSequence: row.stream_sequence,
          receiptState: row.receipt_state,
          acknowledgmentState: row.acknowledgment_state,
        });
      }
    }
    return Object.freeze({
      kind: "SharedStateRestartContinuityConformanceReconcileResponseV1",
      responseVersion: 1,
      scope: "test-only-restart-continuity-conformance-control",
      events,
    });
  }
}

function createWorkerRestartFixtureV1(
  adversarial: AdversarialWorkerRestartControlV1 = {},
): {
  readonly factory: SharedStateRestartContinuityConformanceTargetFactoryV1;
  dispose(): Promise<void>;
} {
  const directories: string[] = [];
  const sessions: SharedStateSqliteWorkerConformanceSessionV1[] = [];
  let ordinal = 0;

  const factory: SharedStateRestartContinuityConformanceTargetFactoryV1 =
    Object.freeze({
      async create(input: {
        readonly clock: SharedStateRestartContinuityConformanceClockV1;
      }): Promise<SharedStateRestartContinuityConformanceTargetV1> {
        ordinal += 1;
        const directory = mkdtempSync(
          join(tmpdir(), "shared-state-worker-restart-target-v1-"),
        );
        directories.push(directory);

        const session = createSharedStateSqliteWorkerConformanceSessionV1({
          filePath: join(directory, "v1.db"),
          ownerToken: `worker-restart-conformance-owner-${ordinal}`,
          backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
          queueCapacity: LANE_QUEUE_CAPACITY,
          acknowledgmentTimeoutMs: 30_000,
          drainTimeoutMs: 30_000,
        });
        sessions.push(session);

        return new WorkerRestartContinuityTargetV1({
          session,
          clock: input.clock,
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
  adversarial: AdversarialWorkerRestartControlV1,
  expected: string,
): Promise<void> {
  const fixture = createWorkerRestartFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStateRestartContinuityConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStateRestartContinuityConformanceErrorV1,
          true,
        );
        if (
          !(error instanceof SharedStateRestartContinuityConformanceErrorV1)
        ) {
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

test("declares the worker-mode Phase 2.4 control inventory and fault mapping", () => {
  for (const control of RESTART_CONTROLS_USED_V1) {
    assert.equal(
      (SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1 as readonly string[])
        .includes(control),
      true,
      `undeclared control: ${control}`,
    );
  }
  // Every harness fault point either maps to a plan or is declared not to be a
  // statement fault. A silent gap would arm nothing and the harness would
  // report crash recovery it never tested.
  for (const point of SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1) {
    const plan = faultPlanFor(point);
    if (point.startsWith("after-")) {
      assert.equal(plan, null);
      continue;
    }
    assert.notEqual(plan, null);
    assert.equal(plan?.repeating, false);
  }
  // The target reaches the database only through the worker.
  const source = WorkerRestartContinuityTargetV1.toString();
  assert.equal(source.includes("DatabaseSync"), false);
  assert.equal(source.includes("prepare("), false);
});

test("runs the Phase 2.4 harness through the V1 SQLite worker lane", async () => {
  const fixture = createWorkerRestartFixtureV1();
  try {
    const report = await runSharedStateRestartContinuityConformanceV1(
      fixture.factory,
    );
    assert.equal(report.status, "passed");
    assert.equal(report.contractVersion, V.versions.contract);
  } finally {
    await fixture.dispose();
  }
});

test("fails closed on each adversarial restart violation in worker mode", async () => {
  await expectWorkerConformanceErrorCode(
    { skipFaultInjection: true },
    "crash_recovery_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { ambiguousCommitRollsBack: true },
    "crash_recovery_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { reopenLosesState: true },
    "continuity_baseline_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { staysReadyOnUnsafeClock: true },
    "backward_clock_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { ignoreReconcileCursor: true },
    "outbox_continuity_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { doubleCountDomainEffects: true },
    "continuity_baseline_mismatch",
  );
});
