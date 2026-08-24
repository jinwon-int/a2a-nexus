/**
 * TEST-ONLY Phase 2.6 conformance target driven through the W1 bounded FIFO
 * worker lane.
 *
 * WHAT THIS SLICE PROVES THAT NO EARLIER ONE DID
 * Every earlier Phase 2 target drove `SharedStateSqliteAdapterV1` inline, on
 * the thread that owned it. W1 proved the lane's own mechanics against focused
 * tests. This is the first proof that a real conformance harness — unmodified —
 * passes with the adapter behind a worker, and that the adversarial cases still
 * fail closed there.
 *
 * NO MAIN-THREAD BYPASS. This target opens no `DatabaseSync` and holds no raw
 * read handle. The worker is the single V1 authority for the file, and every
 * observation this harness needs travels to it over the conformance control
 * channel. That is a stronger position than the inline target's, which reads
 * the same file directly.
 *
 * THE CLOCK. The harness probes `expiry - 1`, `expiry`, and `expiry + 1`
 * exactly, so the observed instant has to be deterministic. The worker still
 * owns and reads its own clock; a control replaces which clock that is. No
 * clock field rides the lane protocol and no instant is attached to a command,
 * so decision W0's prohibition holds.
 *
 * ORDERING. `applyConformanceCleanupControl` and
 * `applyConformanceCapacityControl` are typed `: void` and the harness does not
 * await them. That is satisfiable here because controls and lane requests share
 * one `MessagePort` and `postMessage` delivery is ordered: a control posted
 * before the next lane request is applied before that request executes.
 *
 * What this does NOT do: it checks neither 488 nor 489. Six harnesses still run
 * inline only, and this proves no delayed-or-missing-ACK query case.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SHARED_STATE_EXPIRY_CONFORMANCE_V1,
  SharedStateExpiryConformanceErrorV1,
  runSharedStateExpiryConformanceV1,
  type SharedStateExpiryCleanupControlV1,
  type SharedStateExpiryConformanceClockV1,
  type SharedStateExpiryConformanceTargetFactoryV1,
  type SharedStateExpiryConformanceTargetV1,
} from "./shared-state-expiry-conformance-v1.js";
import {
  SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1,
  SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1,
} from "./shared-state-sqlite-conformance-control-v1.js";
import {
  createSharedStateSqliteWorkerConformanceSessionV1,
  type SharedStateSqliteWorkerConformanceSessionV1,
} from "./shared-state-sqlite-worker-conformance-session-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateTransactionResultV1,
  type SharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";

const SKEW_TOLERANCE_MS =
  SHARED_STATE_EXPIRY_CONFORMANCE_V1.backwardSkewToleranceMs.toString();

/**
 * At least the harness's peak concurrency. A saturated lane answers the surplus
 * with an operation-preserving `unavailable` result, which a harness cannot
 * distinguish from an adapter answering inconsistently.
 */
const LANE_QUEUE_CAPACITY =
  SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedTargetCommandCount;

/**
 * The complete inventory of what worker-mode Phase 2.6 reaches for beyond the
 * closed lane protocol. Asserted so a later slice cannot widen it quietly.
 */
const EXPIRY_CONTROLS_USED_V1 = Object.freeze([
  "expirySafetyReplayState",
  "expirySnapshot",
  "expiryViolation",
  "setObservedInstant",
] as const);

interface AdversarialWorkerExpiryControlV1 {
  readonly earlyEvictionActuallyDeletes?: boolean;
  readonly pressureEvictsUnexpired?: boolean;
  readonly staleBoundaryOffByOne?: boolean;
  readonly implicitTtlOnOutbox?: boolean;
  readonly skipCapacityShedding?: boolean;
}

function transactionResult(
  operation: string,
  tail: Record<string, unknown>,
): unknown {
  const consistency =
    V.operationConsistency[
      operation as keyof typeof V.operationConsistency
    ];
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    consistency: { model: consistency.model, scope: consistency.scope },
    ...tail,
  });
  if (!parsed.ok) {
    throw new SharedStateExpiryConformanceErrorV1("invalid_target_result");
  }
  return parsed.value;
}

function unavailableResult(operation: string): unknown {
  return transactionResult(operation, {
    status: "unavailable",
    completeness: "unavailable",
    reasonCode: "authority_unavailable",
  });
}

function commandInput(
  command: SharedStateTransactionCommandV1,
): Record<string, unknown> {
  return command.input as unknown as Record<string, unknown>;
}

function safetyReplayQuery(
  command: SharedStateTransactionCommandV1,
): Record<string, unknown> {
  const input = commandInput(command);
  return {
    operation: command.operation,
    namespace: String(input["namespace"] ?? ""),
    keyDigest: String(input["keyDigest"] ?? ""),
    nonceDigest:
      typeof input["nonceDigest"] === "string" ? input["nonceDigest"] : null,
  };
}

interface SafetyReplayStateV1 {
  readonly present: boolean;
  readonly expiresAtUnixMs: string | null;
}

class WorkerExpiryConformanceTargetV1
implements SharedStateExpiryConformanceTargetV1 {
  readonly #session: SharedStateSqliteWorkerConformanceSessionV1;
  readonly #clock: SharedStateExpiryConformanceClockV1;
  readonly #adversarial: AdversarialWorkerExpiryControlV1;
  #cleanupState: "none" | "early-eviction-refused" | "deferred" = "none";
  #pressureBand: (typeof V.pressureBands)[number] = "none";

  constructor(input: {
    readonly session: SharedStateSqliteWorkerConformanceSessionV1;
    readonly clock: SharedStateExpiryConformanceClockV1;
    readonly adversarial: AdversarialWorkerExpiryControlV1;
  }) {
    this.#session = input.session;
    this.#clock = input.clock;
    this.#adversarial = input.adversarial;
  }

  #observedAtUnixMs(): string {
    return this.#clock.readObservedUnixMilliseconds().toString();
  }

  /**
   * Publishes the harness instant to the worker that will read it. Posted on
   * the same port as the lane request that follows, so it is applied first.
   */
  #publishInstant(): void {
    this.#session.channel().send("setObservedInstant", {
      observedAtUnixMs: this.#observedAtUnixMs(),
    });
  }

  async #safetyReplayState(
    command: SharedStateTransactionCommandV1,
  ): Promise<SafetyReplayStateV1> {
    return (await this.#session.channel().control(
      "expirySafetyReplayState",
      safetyReplayQuery(command),
    )) as SafetyReplayStateV1;
  }

  async open(): Promise<unknown> {
    // No instant is published here: `open` consumes none, and publishing one
    // would shift every later command's pairing by one.
    const opened = await this.#session.open();
    if (!opened.ok) throw new Error(`open refused: ${opened.error.code}`);
    return opened.value;
  }

  async close(): Promise<unknown> {
    const closed = await this.#session.close();
    if (!closed.ok) throw new Error(`close refused: ${closed.error.code}`);
    return closed.value;
  }

  applyConformanceCleanupControl(
    control: SharedStateExpiryCleanupControlV1,
  ): void {
    if (control === "attempt-early-eviction") {
      if (this.#adversarial.earlyEvictionActuallyDeletes === true) {
        // Violation: cleanup removed a logically active record. V1 has no
        // delete path, so this can only happen if the target does it.
        this.#session.channel().send("expiryViolation", {
          violation: "early-eviction-deletes",
        });
      }
      this.#cleanupState = "early-eviction-refused";
      return;
    }
    if (control !== "defer-physical-cleanup") {
      throw new Error(`unknown cleanup control: ${String(control)}`);
    }
    this.#cleanupState = "deferred";
  }

  applyConformanceCapacityControl(
    band: (typeof V.pressureBands)[number],
  ): void {
    if (this.#adversarial.pressureEvictsUnexpired === true) {
      // Violation: pressure dropped unexpired safety records.
      this.#session.channel().send("expiryViolation", {
        violation: "pressure-evicts-unexpired",
      });
    }
    this.#pressureBand = band;
  }

  async transact(
    command: SharedStateTransactionCommandV1,
  ): Promise<unknown> {
    if (await this.#shouldShed(command)) {
      return unavailableResult(command.operation);
    }
    const inclusiveReplay = await this.#inclusiveReplayAtExpiry(command);
    if (inclusiveReplay !== null) return inclusiveReplay;

    this.#publishInstant();
    const result = await this.#session.lane().transact(command);
    if (!result.ok) throw new Error(`lane refused: ${result.error.code}`);
    return result.value;
  }

  /**
   * Violation: treat `observed == expires` as still active. Shifting the clock
   * cancels, because setup stores expiry from the same shifted instant. The
   * only way to reach the harness check is to answer `replay` at the exclusive
   * instant itself.
   */
  async #inclusiveReplayAtExpiry(
    command: SharedStateTransactionCommandV1,
  ): Promise<unknown | null> {
    if (this.#adversarial.staleBoundaryOffByOne !== true) return null;
    if (command.operation !== "consumeReplayNonce") return null;
    const state = await this.#safetyReplayState(command);
    if (!state.present || state.expiresAtUnixMs === null) return null;
    if (this.#observedAtUnixMs() !== state.expiresAtUnixMs) return null;
    return transactionResult("consumeReplayNonce", {
      status: "committed",
      completeness: "complete",
      result: { decision: "replay", expiresInMs: 1 },
    });
  }

  async #shouldShed(
    command: SharedStateTransactionCommandV1,
  ): Promise<boolean> {
    if (this.#pressureBand !== "critical") return false;
    if (this.#adversarial.skipCapacityShedding === true) return false;
    return !(await this.#isRetainedSafetyReplay(command));
  }

  /**
   * Unexpired replay of an existing nonce, or replay of an existing
   * idempotency key, must survive critical pressure. Everything else is new
   * work and is shed.
   */
  async #isRetainedSafetyReplay(
    command: SharedStateTransactionCommandV1,
  ): Promise<boolean> {
    const state = await this.#safetyReplayState(command);
    if (command.operation === "consumeReplayNonce") {
      if (!state.present || state.expiresAtUnixMs === null) return false;
      return (
        BigInt(state.expiresAtUnixMs)
        > this.#clock.readObservedUnixMilliseconds()
      );
    }
    if (command.operation === "executeIdempotent") return state.present;
    return false;
  }

  async captureConformanceSnapshot(): Promise<unknown> {
    if (this.#adversarial.implicitTtlOnOutbox === true) {
      // Violation: an implicit TTL silently retires an unacknowledged row.
      await this.#session.channel().control("expiryViolation", {
        violation: "implicit-ttl-on-outbox",
      });
    }
    return this.#session.channel().control("expirySnapshot", {
      observedAtUnixMs: this.#observedAtUnixMs(),
      physicalCleanupState: this.#cleanupState,
      capacityPressureBand: this.#pressureBand,
    });
  }
}

function createWorkerExpiryFixtureV1(
  adversarial: AdversarialWorkerExpiryControlV1 = {},
): {
  readonly factory: SharedStateExpiryConformanceTargetFactoryV1;
  dispose(): Promise<void>;
} {
  const directories: string[] = [];
  const sessions: SharedStateSqliteWorkerConformanceSessionV1[] = [];
  let ordinal = 0;

  const factory: SharedStateExpiryConformanceTargetFactoryV1 = Object.freeze({
    async create(input: {
      readonly clock: SharedStateExpiryConformanceClockV1;
    }): Promise<SharedStateExpiryConformanceTargetV1> {
      ordinal += 1;
      const directory = mkdtempSync(
        join(tmpdir(), "shared-state-worker-expiry-target-v1-"),
      );
      directories.push(directory);

      const session = createSharedStateSqliteWorkerConformanceSessionV1({
        filePath: join(directory, "v1.db"),
        ownerToken: `worker-expiry-conformance-owner-${ordinal}`,
        backwardSkewToleranceMs: SKEW_TOLERANCE_MS,
        queueCapacity: LANE_QUEUE_CAPACITY,
        acknowledgmentTimeoutMs: 30_000,
        drainTimeoutMs: 30_000,
      });
      sessions.push(session);

      return new WorkerExpiryConformanceTargetV1({
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
  adversarial: AdversarialWorkerExpiryControlV1,
  expected: string,
): Promise<void> {
  const fixture = createWorkerExpiryFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStateExpiryConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStateExpiryConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStateExpiryConformanceErrorV1)) {
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

test("declares the worker-mode Phase 2.6 boundary and its control inventory", () => {
  assert.equal(
    SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.extendsLaneProtocol,
    false,
  );
  assert.equal(
    SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.carriesArbitrarySql,
    false,
  );
  assert.equal(
    SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.usedByProductionEntry,
    false,
  );
  // Everything this harness reaches for beyond the lane protocol is a declared
  // control, and every one of them is in the closed set.
  for (const control of EXPIRY_CONTROLS_USED_V1) {
    assert.equal(
      (SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1 as readonly string[])
        .includes(control),
      true,
      `undeclared control: ${control}`,
    );
  }
  // The target reaches the database only through the worker.
  const source = WorkerExpiryConformanceTargetV1.toString();
  assert.equal(source.includes("DatabaseSync"), false);
  assert.equal(source.includes("prepare("), false);
});

test("runs the Phase 2.6 harness through the V1 SQLite worker lane", async () => {
  const fixture = createWorkerExpiryFixtureV1();
  try {
    const report = await runSharedStateExpiryConformanceV1(fixture.factory);
    assert.equal(report.status, "passed");
    assert.equal(report.contractVersion, V.versions.contract);
    // The same controls the inline target satisfies, satisfied behind a worker.
    assert.equal(
      report.controls.targetCount,
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.targetCount,
    );
    assert.equal(
      report.controls.targetCommandCount,
      SHARED_STATE_EXPIRY_CONFORMANCE_V1.expectedTargetCommandCount,
    );
  } finally {
    await fixture.dispose();
  }
});

test("fails closed on each adversarial expiry violation in worker mode", async () => {
  await expectWorkerConformanceErrorCode(
    { earlyEvictionActuallyDeletes: true },
    "active_record_removed",
  );
  await expectWorkerConformanceErrorCode(
    { pressureEvictsUnexpired: true },
    "capacity_eviction_permissive",
  );
  await expectWorkerConformanceErrorCode(
    { staleBoundaryOffByOne: true },
    "boundary_operation_mismatch",
  );
  await expectWorkerConformanceErrorCode(
    { implicitTtlOnOutbox: true },
    "implicit_ttl_detected",
  );
  await expectWorkerConformanceErrorCode(
    { skipCapacityShedding: true },
    "capacity_shedding_mismatch",
  );
});
