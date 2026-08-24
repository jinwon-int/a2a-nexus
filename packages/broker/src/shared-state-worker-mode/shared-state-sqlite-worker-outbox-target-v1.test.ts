/**
 * TEST-ONLY Phase 2.3 conformance target driven through the W1 bounded FIFO
 * worker lane.
 *
 * WHAT THIS ADDS OVER W2a AND W2b
 * Phase 2.3 is the first harness whose out-of-band surface is a row set rather
 * than a scalar. Both its snapshot and its reconciliation response are derived
 * from the same committed rows, so worker mode fetches those rows once through
 * one control and derives both on the main thread — exactly as the inline
 * target derives both from one raw query. Deriving them from two separate
 * reads would let a snapshot and a reconciliation disagree about what was
 * committed, which is the specific confusion this harness exists to catch.
 *
 * It is also the first harness with an adversarial reopen that binds to a
 * different database. Inline that is a new `DatabaseSync`; here it is a new
 * worker against a different file, which the session exposes for this one
 * violation.
 *
 * NO MAIN-THREAD BYPASS. This target opens no `DatabaseSync` and holds no raw
 * handle. The inline target keeps two — `reads` and `writes` — against the same
 * file; worker mode collapses both into the worker that owns the connection.
 *
 * What this does NOT do: it checks neither 488 nor 489, and this proves no
 * delayed-or-missing-ACK query case. It also does not re-prove where in the
 * statement stream each armed fault fires — the inline target asserts that
 * against its own `preparedSql` log, and it is a property of the adapter's SQL
 * order rather than of the lane. Decision W6 recorded what does remain
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
  SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1,
  SharedStateOutboxConformanceErrorV1,
  runSharedStateOutboxConformanceV1,
  type SharedStateAcknowledgeOutboxCommandV1,
  type SharedStateAppendOutboxCommandV1,
  type SharedStateOutboxConformanceCursorV1,
  type SharedStateOutboxConformanceFaultPointV1,
  type SharedStateOutboxConformanceTargetFactoryV1,
  type SharedStateOutboxConformanceTargetV1,
  type SharedStateUpdateOutboxReceiptCommandV1,
} from "../shared-state-outbox-conformance-v1.js";
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

const COMMIT_SQL = "COMMIT";
const APPEND_WRITE_SQL_FRAGMENT = "INSERT INTO shared_state_outbox";
const SKEW_TOLERANCE_MS = "0";

/** Deep enough for every command this harness issues. */
const LANE_QUEUE_CAPACITY = 256;

/** Everything worker-mode Phase 2.3 reaches for beyond the lane protocol. */
const OUTBOX_CONTROLS_USED_V1 = Object.freeze([
  "armFault",
  "outboxRows",
  "readFaultState",
  "setObservedInstant",
] as const);

/**
 * Maps each armed fault point onto the statement that is its real boundary.
 * The mapping stays on the main thread: the worker executes plans and knows
 * nothing about which harness produced them.
 */
function faultPlanFor(
  faultPoint: SharedStateOutboxConformanceFaultPointV1,
): SharedStateSqliteConformanceFaultPlanV1 {
  switch (faultPoint) {
    case "domain-before-append":
      return {
        point: faultPoint,
        sqlFragment: APPEND_WRITE_SQL_FRAGMENT,
        phase: "before-prepare",
        repeating: false,
      };
    case "append-before-commit":
    case "ack-before-commit":
      return {
        point: faultPoint,
        sqlFragment: COMMIT_SQL,
        phase: "before-exec",
        repeating: false,
      };
    default:
      throw new Error(`unknown outbox fault point: ${String(faultPoint)}`);
  }
}

interface AdversarialWorkerOutboxControlV1 {
  readonly skipFaultInjection?: boolean;
  readonly doubleCountDomainEffects?: boolean;
  readonly ignoreReconcileCursor?: boolean;
  readonly replayAcknowledgedEvents?: boolean;
  readonly reopenLosesState?: boolean;
}

interface OutboxStateRowV1 {
  readonly stream_key_digest: string;
  readonly event_key_digest: string;
  readonly stream_sequence: string;
  readonly receipt_state: string;
  readonly acknowledgment_state: string;
}

interface FaultStateReplyV1 {
  readonly firedAt: readonly string[];
}

function unavailableResult(operation: string, reasonCode: string): unknown {
  const consistency =
    V.operationConsistency[operation as keyof typeof V.operationConsistency];
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
    throw new SharedStateOutboxConformanceErrorV1("invalid_target_result");
  }
  return parsed.value;
}

class WorkerOutboxConformanceTargetV1
implements SharedStateOutboxConformanceTargetV1 {
  readonly #session: SharedStateSqliteWorkerConformanceSessionV1;
  readonly #adversarial: AdversarialWorkerOutboxControlV1;
  /**
   * The harness injects no clock, so the target owns a monotonic counter — the
   * same one the inline target owns. It is published to the worker per command
   * rather than attached to it, so no clock field rides the lane protocol.
   */
  #observed = 0;
  #seenFiredCount = 0;

  constructor(input: {
    readonly session: SharedStateSqliteWorkerConformanceSessionV1;
    readonly adversarial: AdversarialWorkerOutboxControlV1;
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

  async #rows(): Promise<readonly OutboxStateRowV1[]> {
    return (await this.#session.channel().control(
      "outboxRows",
    )) as readonly OutboxStateRowV1[];
  }

  async open(): Promise<unknown> {
    const opened = await this.#session.open();
    if (!opened.ok) throw new Error(`lane open refused: ${opened.error.code}`);
    return opened.value;
  }

  async close(): Promise<unknown> {
    const closed = await this.#session.close();
    if (!closed.ok) throw new Error(`lane close refused: ${closed.error.code}`);
    if (this.#adversarial.reopenLosesState === true) {
      // Violation: the reopened worker is bound to a fresh database, so the
      // events committed before the close are silently gone. The observation
      // surface moves with it, because it lives in that same worker — which is
      // exactly why worker mode cannot make this violation invisible.
      const directory = mkdtempSync(
        join(tmpdir(), "shared-state-worker-outbox-lost-"),
      );
      this.#session.rebindFilePathForViolation(join(directory, "v1.db"));
    }
    return closed.value;
  }

  armFault(faultPoint: SharedStateOutboxConformanceFaultPointV1): void {
    if (!SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1.includes(faultPoint)) {
      throw new Error(`unknown outbox fault point: ${faultPoint}`);
    }
    if (this.#adversarial.skipFaultInjection === true) return;
    // Posted on the same port as the lane request that follows, so it is armed
    // before that request executes even though the harness never awaits this.
    this.#session.channel().send("armFault", faultPlanFor(faultPoint));
  }

  async #transact(command: SharedStateTransactionCommandV1): Promise<unknown> {
    this.#observed += 1;
    this.#session.channel().send("setObservedInstant", {
      observedAtUnixMs: this.#observed.toString(),
    });
    const result = await this.#session.lane().transact(command);

    // An injected fault surfaces as a closed adapter failure, which is
    // indistinguishable from a real store failure without asking the worker
    // whether its seam fired.
    const firedCount = await this.#firedCount();
    if (firedCount > this.#seenFiredCount) {
      this.#seenFiredCount = firedCount;
      // The adapter rolled its own transaction back. Nothing was written.
      return unavailableResult(command.operation, "authority_unavailable");
    }

    if (!result.ok) throw new Error(`lane refused: ${result.error.code}`);
    return result.value;
  }

  async appendOutbox(
    command: SharedStateAppendOutboxCommandV1,
  ): Promise<unknown> {
    return this.#transact(command);
  }

  async updateOutboxReceipt(
    command: SharedStateUpdateOutboxReceiptCommandV1,
  ): Promise<unknown> {
    return this.#transact(command);
  }

  async acknowledgeOutbox(
    command: SharedStateAcknowledgeOutboxCommandV1,
  ): Promise<unknown> {
    return this.#transact(command);
  }

  async snapshot(): Promise<unknown> {
    const rows = await this.#rows();
    const count = (predicate: (row: OutboxStateRowV1) => boolean): number =>
      rows.filter(predicate).length;
    return Object.freeze({
      kind: "SharedStateOutboxConformanceSnapshotV1",
      snapshotVersion: 1,
      // V1 keeps no domain-effect record apart from the event it appended.
      domainEffectCount:
        this.#adversarial.doubleCountDomainEffects === true
          ? rows.length * 2
          : rows.length,
      outboxEventCount: rows.length,
      receiptPendingCount: count((row) => row.receipt_state === "pending"),
      receiptConfirmedCount: count((row) => row.receipt_state === "confirmed"),
      // Real query, not a hard-coded zero: no scenario fails a receipt.
      receiptFailedCount: count((row) => row.receipt_state === "failed"),
      unacknowledgedCount: count(
        (row) => row.acknowledgment_state === "unacknowledged",
      ),
      acknowledgedCount: count(
        (row) => row.acknowledgment_state === "acknowledged",
      ),
    });
  }

  async reconcileConformanceControl(
    cursor: SharedStateOutboxConformanceCursorV1,
  ): Promise<unknown> {
    const rows = await this.#rows();
    const events: Record<string, unknown>[] = [];
    for (const position of cursor.positions) {
      // The cursor carries both a read position and an acknowledged prefix;
      // the effective floor is whichever is further along.
      const after = BigInt(position.afterSequence);
      const acknowledged = BigInt(position.acknowledgedThroughSequence);
      const floor = after > acknowledged ? after : acknowledged;
      const forStream = rows
        .filter((row) => row.stream_key_digest === position.streamKeyDigest)
        .filter((row) => {
          const unacknowledged = row.acknowledgment_state === "unacknowledged";
          if (this.#adversarial.replayAcknowledgedEvents === true) {
            // Acknowledged rows bypass the floor as well, or the floor would
            // hide them and this control would silently pass.
            if (!unacknowledged) return true;
          } else if (!unacknowledged) {
            return false;
          }
          return this.#adversarial.ignoreReconcileCursor === true
            ? true
            : BigInt(row.stream_sequence) > floor;
        })
        .sort((left, right) =>
          BigInt(left.stream_sequence) < BigInt(right.stream_sequence) ? -1 : 1
        );
      for (const row of forStream) {
        events.push({
          streamKeyDigest: row.stream_key_digest,
          eventKeyDigest: row.event_key_digest,
          streamSequence: row.stream_sequence,
          receiptState: row.receipt_state,
          acknowledgmentState: row.acknowledgment_state,
        });
      }
    }
    return Object.freeze({
      kind: "SharedStateOutboxConformanceReconcileResponseV1",
      responseVersion: 1,
      scope: "test-only-conformance-control",
      events,
    });
  }
}

function createWorkerOutboxFixtureV1(
  adversarial: AdversarialWorkerOutboxControlV1 = {},
): {
  readonly factory: SharedStateOutboxConformanceTargetFactoryV1;
  dispose(): Promise<void>;
} {
  const directories: string[] = [];
  const sessions: SharedStateSqliteWorkerConformanceSessionV1[] = [];
  let ordinal = 0;

  const factory: SharedStateOutboxConformanceTargetFactoryV1 = Object.freeze({
    async create(): Promise<SharedStateOutboxConformanceTargetV1> {
      ordinal += 1;
      const directory = mkdtempSync(
        join(tmpdir(), "shared-state-worker-outbox-target-v1-"),
      );
      directories.push(directory);

      const session = createSharedStateSqliteWorkerConformanceSessionV1({
        filePath: join(directory, "v1.db"),
        ownerToken: `worker-outbox-conformance-owner-${ordinal}`,
        backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
        queueCapacity: LANE_QUEUE_CAPACITY,
        acknowledgmentTimeoutMs: 30_000,
        drainTimeoutMs: 30_000,
      });
      sessions.push(session);

      return new WorkerOutboxConformanceTargetV1({ session, adversarial });
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
  adversarial: AdversarialWorkerOutboxControlV1,
  expected: string,
): Promise<void> {
  const fixture = createWorkerOutboxFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStateOutboxConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStateOutboxConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStateOutboxConformanceErrorV1)) {
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

test("declares the worker-mode Phase 2.3 control inventory and fault mapping", () => {
  for (const control of OUTBOX_CONTROLS_USED_V1) {
    assert.equal(
      (SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1 as readonly string[])
        .includes(control),
      true,
      `undeclared control: ${control}`,
    );
  }
  // Every harness fault point maps to a plan. A missing case would arm nothing
  // and the harness would report atomicity it never tested.
  for (const point of SHARED_STATE_OUTBOX_CONFORMANCE_FAULT_POINTS_V1) {
    const plan = faultPlanFor(point);
    assert.equal(plan.point, point);
    assert.equal(plan.repeating, false);
  }
  // The target reaches the database only through the worker. The inline target
  // holds two handles against the same file; this one holds none.
  const source = WorkerOutboxConformanceTargetV1.toString();
  assert.equal(source.includes("DatabaseSync"), false);
  assert.equal(source.includes("prepare("), false);
});

test("runs the Phase 2.3 harness through the V1 SQLite worker lane", async () => {
  const fixture = createWorkerOutboxFixtureV1();
  try {
    const report = await runSharedStateOutboxConformanceV1(fixture.factory);
    assert.equal(report.status, "passed");
    assert.equal(report.contractVersion, V.versions.contract);
  } finally {
    await fixture.dispose();
  }
});

test("fails closed on each adversarial outbox violation in worker mode", async () => {
  await expectWorkerConformanceErrorCode(
    { skipFaultInjection: true },
    "transaction_not_atomic",
  );
  await expectWorkerConformanceErrorCode(
    { doubleCountDomainEffects: true },
    "retry_binding_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { ignoreReconcileCursor: true },
    "reconcile_invariant_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { replayAcknowledgedEvents: true },
    "reconcile_invariant_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { reopenLosesState: true },
    "reopen_snapshot_mismatch",
  );
});
