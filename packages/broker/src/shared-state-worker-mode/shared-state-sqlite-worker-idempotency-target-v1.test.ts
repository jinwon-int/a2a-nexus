/**
 * TEST-ONLY Phase 2.2 conformance target driven through the W1 bounded FIFO
 * worker lane.
 *
 * WHAT THIS SLICE PROVES THAT W2a DID NOT
 * W2a moved Phase 2.6 onto the worker scaffolding, and 2.6 is the one harness
 * with no statement proxy at all. So the scaffolding's fault seam — the part
 * that fires inside the adapter's transaction, in the worker — was built but
 * never exercised. Phase 2.2 arms four statement faults and asks the target
 * whether each one fired, which is the first real test of that seam and of the
 * `readFaultState` control W2a left unverified.
 *
 * HOW FIRING IS OBSERVED. The inline target reads a boolean it shares with its
 * own proxy. Here the proxy lives in the worker, so the target compares the
 * worker's monotonic fired count before and after the command instead of
 * resetting a flag. A count cannot be lost to a race the way a reset flag can:
 * if a fault fires between the reset and the read, a flag reports the wrong
 * transaction while a count still reports the right delta.
 *
 * NO MAIN-THREAD BYPASS. This target opens no `DatabaseSync` and holds no raw
 * read handle. Effect counts travel over the conformance control channel.
 *
 * What this does NOT do: it checks neither 488 nor 489, and this proves no
 * delayed-or-missing-ACK query case. It also does not re-prove the adapter's
 * statement ordering, which the inline target already asserts and which is a
 * property of the adapter rather than of the lane. Decision W6 recorded what does remain
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
  SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1,
  SHARED_STATE_IDEMPOTENCY_FAULT_POINTS_V1,
  SharedStateIdempotencyConformanceErrorV1,
  runSharedStateIdempotencyConformanceV1,
  type SharedStateExecuteIdempotentCommandV1,
  type SharedStateIdempotencyConformanceClockV1,
  type SharedStateIdempotencyConformanceTargetFactoryV1,
  type SharedStateIdempotencyConformanceTargetV1,
  type SharedStateIdempotencyFaultPointV1,
} from "../shared-state-idempotency-conformance-v1.js";
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
} from "../shared-state-storage-contract-v1.js";

const COMMIT_SQL = "COMMIT";
const LINK_WRITE_SQL_FRAGMENT = "INSERT INTO shared_state_idempotency_outbox_link";
const OUTCOME_WRITE_SQL_FRAGMENT = "INSERT INTO shared_state_idempotency\n";

const SKEW_TOLERANCE_MS = "0";

/**
 * The lane queue must be at least as deep as the harness's peak concurrency.
 * Phase 2.2 submits sixty-four same-fingerprint contenders at once, and a
 * saturated lane answers the surplus with an operation-preserving `unavailable`
 * result — correct lane behaviour, but indistinguishable to the harness from an
 * adapter that gave contenders different outcomes. Sizing from the harness's own
 * declared operation count keeps the queue a scheduling detail rather than a
 * silent participant in the proof. The inline target has no queue at all, which
 * is why nothing surfaced this until worker mode.
 */
const LANE_QUEUE_CAPACITY =
  SHARED_STATE_IDEMPOTENCY_CONFORMANCE_V1.expectedOperationCount;

/** Everything worker-mode Phase 2.2 reaches for beyond the lane protocol. */
const IDEMPOTENCY_CONTROLS_USED_V1 = Object.freeze([
  "armFault",
  "idempotencyEffectCounts",
  "readFaultState",
  "setObservedInstant",
] as const);

/**
 * The harness's fault vocabulary translated into the seam's mechanical plan.
 * This mapping stays on the main thread on purpose: the worker executes plans
 * and knows nothing about which harness produced them, which is what lets one
 * conformance worker serve all seven.
 */
function faultPlanFor(
  faultPoint: SharedStateIdempotencyFaultPointV1,
): SharedStateSqliteConformanceFaultPlanV1 | null {
  switch (faultPoint) {
    case "after_reservation":
    case "after_domain_mutation":
      return {
        point: faultPoint,
        sqlFragment: LINK_WRITE_SQL_FRAGMENT,
        phase: "before-prepare",
        repeating: false,
      };
    case "after_outbox_staging":
      return {
        point: faultPoint,
        sqlFragment: OUTCOME_WRITE_SQL_FRAGMENT,
        phase: "before-prepare",
        repeating: false,
      };
    case "after_outcome_staging":
      return {
        point: faultPoint,
        sqlFragment: COMMIT_SQL,
        phase: "before-exec",
        repeating: false,
      };
    default:
      // `after_commit_before_response` is not a statement fault: the
      // transaction must genuinely commit first.
      return null;
  }
}

interface AdversarialWorkerIdempotencyControlV1 {
  readonly doubleCountOutboxAppends?: boolean;
  readonly skipFaultInjection?: boolean;
  readonly skipTransactionFaultInjection?: boolean;
  readonly ambiguousCommitRollsBack?: boolean;
}

function unavailableResult(reasonCode: string): unknown {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "executeIdempotent",
    status: "unavailable",
    consistency: {
      model: V.operationConsistency.executeIdempotent.model,
      scope: V.operationConsistency.executeIdempotent.scope,
    },
    completeness: V.resultCompletenessStates[1],
    reasonCode,
  });
  if (!parsed.ok) {
    throw new SharedStateIdempotencyConformanceErrorV1("invalid_target_result");
  }
  return parsed.value;
}

interface FaultStateReplyV1 {
  readonly armedPoint: string | null;
  readonly fired: boolean;
  readonly firedAt: readonly string[];
}

interface EffectCountsV1 {
  readonly outcomeCount: number;
  readonly linkCount: number;
}

class WorkerIdempotencyConformanceTargetV1
implements SharedStateIdempotencyConformanceTargetV1 {
  readonly #session: SharedStateSqliteWorkerConformanceSessionV1;
  readonly #clock: SharedStateIdempotencyConformanceClockV1;
  readonly #adversarial: AdversarialWorkerIdempotencyControlV1;
  #armedAmbiguousCommit = false;
  /**
   * The worker's fired count as of the last command. A delta against it says
   * whether a fault fired during the command just issued.
   */
  #seenFiredCount = 0;

  constructor(input: {
    readonly session: SharedStateSqliteWorkerConformanceSessionV1;
    readonly clock: SharedStateIdempotencyConformanceClockV1;
    readonly adversarial: AdversarialWorkerIdempotencyControlV1;
  }) {
    this.#session = input.session;
    this.#clock = input.clock;
    this.#adversarial = input.adversarial;
  }

  #publishInstant(): void {
    this.#session.channel().send("setObservedInstant", {
      observedAtUnixMs: this.#clock.readLogicalMilliseconds().toString(),
    });
  }

  async #firedCount(): Promise<number> {
    const state = (await this.#session.channel().control(
      "readFaultState",
    )) as FaultStateReplyV1;
    return state.firedAt.length;
  }

  async open(): Promise<unknown> {
    // No instant is published here: `open` consumes none, and publishing one
    // would shift every later command's pairing by one.
    const opened = await this.#session.open();
    if (!opened.ok) throw new Error(`lane open refused: ${opened.error.code}`);
    return opened.value;
  }

  async close(): Promise<unknown> {
    const closed = await this.#session.close();
    if (!closed.ok) throw new Error(`lane close refused: ${closed.error.code}`);
    return closed.value;
  }

  armFault(faultPoint: SharedStateIdempotencyFaultPointV1): void {
    if (!SHARED_STATE_IDEMPOTENCY_FAULT_POINTS_V1.includes(faultPoint)) {
      throw new Error(`unknown idempotency fault point: ${faultPoint}`);
    }
    if (this.#adversarial.skipFaultInjection === true) return;
    if (faultPoint === "after_commit_before_response") {
      this.#armedAmbiguousCommit = true;
      return;
    }
    if (this.#adversarial.skipTransactionFaultInjection === true) return;
    const plan = faultPlanFor(faultPoint);
    if (plan === null) return;
    // Posted on the same port as the lane request that follows, so it is armed
    // before that request executes even though the harness never awaits this.
    this.#session.channel().send("armFault", plan);
  }

  async executeIdempotent(
    command: SharedStateExecuteIdempotentCommandV1,
  ): Promise<unknown> {
    if (this.#armedAmbiguousCommit) {
      this.#armedAmbiguousCommit = false;
      if (this.#adversarial.ambiguousCommitRollsBack === true) {
        // Violation: the caller is told the commit is ambiguous while nothing
        // was actually written, so a retry would execute a second time.
        return unavailableResult("ambiguous_commit");
      }
      // The transaction really commits. Only the answer is lost, which is
      // exactly what an ambiguous commit is.
      this.#publishInstant();
      const committed = await this.#session.lane().transact(command);
      if (!committed.ok) {
        throw new Error(`lane refused: ${committed.error.code}`);
      }
      return unavailableResult("ambiguous_commit");
    }

    this.#publishInstant();
    const result = await this.#session.lane().transact(command);

    // Read the count before deciding: an injected fault surfaces as a closed
    // adapter failure, which is indistinguishable from a real store failure
    // without asking the worker whether its seam fired.
    const firedCount = await this.#firedCount();
    if (firedCount > this.#seenFiredCount) {
      this.#seenFiredCount = firedCount;
      // The adapter rolled its own transaction back. Nothing was written.
      return unavailableResult("authority_unavailable");
    }

    if (!result.ok) throw new Error(`lane refused: ${result.error.code}`);
    return result.value;
  }

  async snapshot(): Promise<unknown> {
    const counts = (await this.#session.channel().control(
      "idempotencyEffectCounts",
    )) as EffectCountsV1;
    return Object.freeze({
      kind: "SharedStateIdempotencyConformanceSnapshotV1",
      snapshotVersion: 1,
      // One durable record stands for the reservation, the declared domain
      // mutation, and the stable outcome.
      reservationCount: counts.outcomeCount,
      // V1 has no reservation to leave pending. This zero is real.
      pendingReservationCount: 0,
      domainMutationCount: counts.outcomeCount,
      outboxAppendCount:
        this.#adversarial.doubleCountOutboxAppends === true
          ? counts.linkCount * 2
          : counts.linkCount,
      stableOutcomeCount: counts.outcomeCount,
    });
  }
}

function createWorkerIdempotencyFixtureV1(
  adversarial: AdversarialWorkerIdempotencyControlV1 = {},
): {
  readonly factory: SharedStateIdempotencyConformanceTargetFactoryV1;
  dispose(): Promise<void>;
} {
  const directories: string[] = [];
  const sessions: SharedStateSqliteWorkerConformanceSessionV1[] = [];
  let ordinal = 0;

  const factory: SharedStateIdempotencyConformanceTargetFactoryV1 =
    Object.freeze({
      async create(input: {
        readonly clock: SharedStateIdempotencyConformanceClockV1;
      }): Promise<SharedStateIdempotencyConformanceTargetV1> {
        ordinal += 1;
        const directory = mkdtempSync(
          join(tmpdir(), "shared-state-worker-idempotency-target-v1-"),
        );
        directories.push(directory);

        const session = createSharedStateSqliteWorkerConformanceSessionV1({
          filePath: join(directory, "v1.db"),
          ownerToken: `worker-idempotency-conformance-owner-${ordinal}`,
          backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
          queueCapacity: LANE_QUEUE_CAPACITY,
          acknowledgmentTimeoutMs: 30_000,
          drainTimeoutMs: 30_000,
        });
        sessions.push(session);

        return new WorkerIdempotencyConformanceTargetV1({
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
  adversarial: AdversarialWorkerIdempotencyControlV1,
  expected: string,
): Promise<void> {
  const fixture = createWorkerIdempotencyFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStateIdempotencyConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStateIdempotencyConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStateIdempotencyConformanceErrorV1)) {
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

test("declares the worker-mode Phase 2.2 control inventory and fault mapping", () => {
  for (const control of IDEMPOTENCY_CONTROLS_USED_V1) {
    assert.equal(
      (SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1 as readonly string[])
        .includes(control),
      true,
      `undeclared control: ${control}`,
    );
  }
  // Every harness fault point maps to a plan or is declared not to be a
  // statement fault. A silent `undefined` here would arm nothing and the
  // harness would report atomicity it never tested.
  for (const point of SHARED_STATE_IDEMPOTENCY_FAULT_POINTS_V1) {
    const plan = faultPlanFor(point);
    if (point === "after_commit_before_response") {
      assert.equal(plan, null);
      continue;
    }
    assert.notEqual(plan, null);
    assert.equal(plan?.repeating, false);
  }
  // The target reaches the database only through the worker.
  const source = WorkerIdempotencyConformanceTargetV1.toString();
  assert.equal(source.includes("DatabaseSync"), false);
  assert.equal(source.includes("prepare("), false);
});

test("runs the Phase 2.2 harness through the V1 SQLite worker lane", async () => {
  const fixture = createWorkerIdempotencyFixtureV1();
  try {
    const report = await runSharedStateIdempotencyConformanceV1(
      fixture.factory,
    );
    assert.equal(report.status, "passed");
    assert.equal(report.scope, "execute-idempotent");
    assert.equal(report.contractVersion, V.versions.contract);
  } finally {
    await fixture.dispose();
  }
});

test("fails closed on each adversarial idempotency violation in worker mode", async () => {
  await expectWorkerConformanceErrorCode(
    { doubleCountOutboxAppends: true },
    "effect_snapshot_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { skipFaultInjection: true },
    "ambiguous_commit_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { skipTransactionFaultInjection: true },
    "transaction_not_atomic",
  );
  await expectWorkerConformanceErrorCode(
    { ambiguousCommitRollsBack: true },
    "ambiguous_commit_mismatch",
  );
});
